/**
 * WebhooksController — the inbound side of the provider integration.
 *
 *   POST /webhooks/paystack     — Paystack events
 *   POST /webhooks/stripe      — Stripe events (lands in PR-NN4)
 *   POST /webhooks/flutterwave  — Flutterwave events (lands in PR-NN3)
 *
 * The route is unauthenticated by design — the signature header
 * IS the authentication. Each provider's webhook adapter
 * (PaystackWebhookAdapter today, plus the others as they land)
 * verifies the signature against the exact byte stream of the
 * request body and normalizes the payload to
 * `NormalizedPaymentEvent` in a single call. The
 * `verifyAndNormalizeWebhook` step is non-separable: there's no
 * legitimate way to normalize an unverified body.
 *
 * The raw body is captured by `RawBodyMiddleware` (configured
 * globally in `InterfaceModule.configure`). Re-serializing the
 * body as JSON would invalidate the signature, so we never
 * destructure `req.body` for the webhook path.
 */
import {
  BadRequestException,
  Controller,
  HttpCode,
  HttpException,
  HttpStatus,
  Inject,
  Logger,
  Post,
  Req,
  UnauthorizedException,
} from '@nestjs/common';
import type { Request } from 'express';

import { HandlePaymentWebhookUseCase } from '../../../payments/application/handle-payment-webhook.use-case';
import type { ProviderWebhookPort } from '../../../provider-integration/application/ports/provider-webhook.port';
import { PaystackWebhookAdapter } from '../../../provider-integration/infrastructure/paystack/paystack-webhook.adapter';
import type { DomainError } from '../../../shared/kernel/domain-error';
import { WebhookHandlingResponseDto } from '../dto/webhook.dto';

/**
 * DI tokens for the per-provider webhook adapters. We inject
 * each adapter by class (NestJS uses the class as the token
 * by default), and the controller dispatches by URL path. As
 * Stripe + Flutterwave adapters land, add their class names
 * here and a corresponding `@Post(':provider')` handler. The
 * token set lives in this file because it's the only place
 * that needs to know.
 */
const PAYSTACK_WEBHOOK = PaystackWebhookAdapter;

@Controller('webhooks')
export class WebhooksController {
  private readonly logger = new Logger(WebhooksController.name);

  constructor(
    @Inject(PAYSTACK_WEBHOOK)
    private readonly paystackWebhook: ProviderWebhookPort,
    private readonly handleWebhook: HandlePaymentWebhookUseCase,
  ) {}

  /**
   * Paystack webhook endpoint.
   *
   * Paystack's webhook headers we use:
   *   - `x-paystack-signature`: HMAC-SHA512 of the raw body
   *     using the secret key as the key, hex-encoded.
   *
   * The signature scheme is verified inside
   * `PaystackWebhookAdapter.verifyAndNormalizeWebhook` —
   * the controller is just the HTTP transport. Bad signature
   * → 401. Malformed body → 400. Validation passed → 200 with
   * the handling outcome.
   */
  @Post('paystack')
  @HttpCode(HttpStatus.OK)
  async paystack(@Req() req: Request): Promise<WebhookHandlingResponseDto> {
    return this.dispatch(this.paystackWebhook, req);
  }

  private async dispatch(
    adapter: ProviderWebhookPort,
    req: Request,
  ): Promise<WebhookHandlingResponseDto> {
    const rawBody = (req as Request & { rawBody?: Buffer }).rawBody;
    if (!rawBody) {
      // The raw-body middleware should always populate
      // rawBody for POST requests. If it's missing, the
      // middleware chain is broken — fail loud, not silent.
      throw new BadRequestException(
        'request body was empty; cannot verify webhook signature without raw bytes',
      );
    }

    const headers: Record<string, string | string[] | undefined> = {};
    for (const [name, value] of Object.entries(req.headers)) {
      headers[name] = value;
    }

    const verification = await adapter.verifyAndNormalizeWebhook(
      rawBody,
      headers,
    );
    if (!verification.ok) {
      throw this.mapWebhookError(verification.error);
    }
    const event = verification.value;

    const result = await this.handleWebhook.execute(event);
    if (!result.ok) {
      throw this.mapWebhookError(result.error);
    }

    this.logger.log(
      {
        provider: adapter.provider,
        outcome: result.value.outcome,
        intentId:
          result.value.outcome === 'APPLIED'
            ? result.value.intentId
            : undefined,
      },
      'webhook handled',
    );

    const dto = new WebhookHandlingResponseDto();
    dto.outcome = result.value.outcome;
    if (result.value.outcome === 'APPLIED') {
      dto.intentId = result.value.intentId;
    }
    return dto;
  }

  private mapWebhookError(error: DomainError): Error {
    // Webhook adapters throw typed errors with a `code` field.
    // The codes we map to HTTP are:
    //   - INVALID_PROVIDER_PAYLOAD     → 400 (we couldn't parse it)
    //   - INVALID_WEBHOOK_SIGNATURE    → 401 (auth failed)
    //   - UNRECOGNIZED_PROVIDER_EVENT  → 200 with outcome: 'DUPLICATE_IGNORED'
    //   - everything else              → 500
    if (error.code === 'INVALID_WEBHOOK_SIGNATURE') {
      return new UnauthorizedException(error.message);
    }
    if (error.code === 'INVALID_PROVIDER_PAYLOAD') {
      return new BadRequestException(error.message);
    }
    return new HttpException(
      { message: error.message, code: error.code },
      HttpStatus.INTERNAL_SERVER_ERROR,
    );
  }
}
