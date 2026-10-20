/**
 * PaymentsController — the public HTTP surface for initiating and
 * fetching payment intents.
 *
 *   POST /payments         — initiate a payment
 *   GET  /payments/:id     — fetch a single intent by id
 *
 * Both routes are protected by the NoAuthGuard (V1) which
 * parses the `X-Dev-Principal` header into a typed `Principal`
 * and stashes it on `req.principal`. PR-NN2 (Cerberus auth)
 * replaces the guard but keeps the `req.principal` contract.
 *
 * Per-request use case construction
 * --------------------------------
 * The `InitiatePaymentUseCase` takes its `principal` via the
 * `deps` bag, not as a call argument, so we can't inject the
 * use case once at boot — the principal differs per request.
 * The controller uses the `InitiatePaymentFactory` (a Nest
 * provider) to build a per-request use case instance.
 */
import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpException,
  HttpStatus,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import type { Result } from '../../../shared/kernel/result';
import { InitiatePaymentUseCase } from '../../../payments/application/initiate-payment.use-case';
import { PostgresPaymentIntentRepository } from '../../../payments/infrastructure/postgres-payment-intent.repository';
import { type Principal } from '../../../shared/kernel/tenant';
import { NoAuthGuard } from '../../../auth/no-auth.guard';
import { InitiatePaymentFactory } from '../use-cases/initiate-payment.factory';
import {
  InitiatePaymentRequestDto,
  InitiatePaymentResponseDto,
} from '../dto/payments.dto';
import type { RequestWithPrincipal } from '../middleware/request-with-principal';
import type { DomainError } from '../../../shared/kernel/domain-error';

@Controller('payments')
@UseGuards(NoAuthGuard)
export class PaymentsController {
  constructor(
    private readonly initiateFactory: InitiatePaymentFactory,
    private readonly intents: PostgresPaymentIntentRepository,
  ) {}

  /**
   * Initiate a payment. The body is validated by class-validator
   * decorators on `InitiatePaymentRequestDto` (configured in
   * main.ts with whitelist + forbidNonWhitelisted + transform).
   *
   * Returns 201 on APPLIED (a fresh intent was created), 200 on
   * idempotency replay (the same key produced a cached result),
   * 400 on domain validation failure (e.g. unknown payment
   * method), 502 on gateway failure, 500 on infrastructure
   * failure.
   */
  @Post()
  @HttpCode(HttpStatus.CREATED)
  async initiate(
    @Body() body: InitiatePaymentRequestDto,
    @Req() req: RequestWithPrincipal,
  ): Promise<InitiatePaymentResponseDto> {
    const principal = this.requirePrincipal(req);
    const useCase = this.initiateFactory.for(principal);
    const command = this.toCommand(body);

    const result = await useCase.execute(command);
    return this.toResponse(result);
  }

  /**
   * Fetch a single payment intent by id. Returns 404 if the
   * intent doesn't exist OR if it belongs to a different
   * tenant — the second case is intentional: a principal
   * asking for an intent outside their tenant should not be
   * able to distinguish "doesn't exist" from "exists but you
   * can't see it".
   */
  @Get(':id')
  async findById(
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
    @Req() req: RequestWithPrincipal,
  ): Promise<{ intentId: string; status: string; provider: string }> {
    const principal = this.requirePrincipal(req);
    const intent = await this.intents.findById(id);
    if (!intent) throw new NotFoundException(`payment intent ${id} not found`);
    if (intent.tenantId !== principal.tenantId) {
      throw new NotFoundException(`payment intent ${id} not found`);
    }
    return {
      intentId: intent.intentId,
      status: intent.currentStatus,
      provider: intent.provider,
    };
  }

  private requirePrincipal(req: RequestWithPrincipal): Principal {
    if (!req.principal) {
      // The NoAuthGuard runs first and sets req.principal (or
      // throws 401). Reaching here without a principal is a
      // guard-misconfiguration — fail loud, not silent.
      throw new Error('NoAuthGuard did not set req.principal');
    }
    return req.principal;
  }

  private toCommand(
    dto: InitiatePaymentRequestDto,
  ): Parameters<InitiatePaymentUseCase['execute']>[0] {
    // The DTO field names match the command field names 1:1;
    // a manual copy is explicit and lets tsc catch any future
    // drift.
    return {
      amountMinor: dto.amountMinor,
      currency: dto.currency,
      method: dto.method,
      idempotencyKey: dto.idempotencyKey,
      ...(dto.customerRef !== undefined
        ? { customerRef: dto.customerRef }
        : {}),
      ...(dto.description !== undefined
        ? { description: dto.description }
        : {}),
      ...(dto.customerEmail !== undefined
        ? { customerEmail: dto.customerEmail }
        : {}),
      ...(dto.callbackUrl !== undefined
        ? { callbackUrl: dto.callbackUrl }
        : {}),
      ...(dto.cardOrigin !== undefined ? { cardOrigin: dto.cardOrigin } : {}),
    };
  }

  private toResponse(
    result: Result<
      Awaited<ReturnType<InitiatePaymentUseCase['execute']>> extends Result<
        infer T,
        unknown
      >
        ? T
        : never,
      DomainError
    >,
  ): InitiatePaymentResponseDto {
    if (result.ok) {
      return InitiatePaymentResponseDto.from(result.value);
    }
    throw mapDomainErrorToHttp(result.error);
  }
}

/**
 * Map a DomainError to an HTTP exception. Lives at the bottom of
 * the file so the controller's happy path stays linear.
 */
function mapDomainErrorToHttp(error: DomainError): HttpException {
  if (
    error.code === 'UNKNOWN_PAYMENT_METHOD' ||
    error.code === 'INVALID_IDEMPOTENCY_KEY' ||
    error.code === 'REQUEST_IN_PROGRESS' ||
    error.code === 'INVALID_MONEY'
  ) {
    return new HttpException(
      { statusCode: 400, message: error.message, code: error.code },
      HttpStatus.BAD_REQUEST,
    );
  }
  if (
    error.code === 'HTTP_TRANSPORT_ERROR' ||
    error.code === 'PROVIDER_API_ERROR'
  ) {
    return new HttpException(
      { statusCode: 502, message: error.message, code: error.code },
      HttpStatus.BAD_GATEWAY,
    );
  }
  return new HttpException(
    { statusCode: 500, message: error.message, code: error.code },
    HttpStatus.INTERNAL_SERVER_ERROR,
  );
}
