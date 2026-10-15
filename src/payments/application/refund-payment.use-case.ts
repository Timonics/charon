import { LedgerAppender } from '../../ledger/application/ledger-appender';
import { err, ok, type Result } from '../../shared/kernel/result';
import { parseIdempotencyKey } from '../../shared/kernel/idempotency-key';
import { Money } from '../../shared/kernel/money';
import type { UnitOfWork } from '../../shared/infrastructure/unit-of-work';
import { DomainError } from '../../shared/kernel/domain-error';
import { serializePaymentEvent } from './event-serializer';
import { RequestInProgressError } from './errors';
import type { IdempotencyStore } from './ports/idempotency-store';
import type { PaymentIntentRepository } from './ports/payment-intent.repository';

const IDEMPOTENCY_SCOPE = 'payments.refund';

export interface RefundPaymentCommand {
  readonly intentId: string;
  readonly amountMinor: number;
  readonly currency: string;
  readonly idempotencyKey: string;
  readonly reason?: string;
}

export interface RefundPaymentResult {
  readonly intentId: string;
  readonly status: string;
  readonly refundedToDate: {
    readonly amount: number;
    readonly currency: string;
  };
}

export interface RefundPaymentDeps {
  readonly idempotency: IdempotencyStore;
  readonly intents: PaymentIntentRepository;
  readonly ledger: LedgerAppender;
  readonly unitOfWork: UnitOfWork;
}

/**
 * Refunds part of a SUCCEEDED payment intent. Cumulative refunds cannot
 * exceed the original charge (the domain enforces this — see
 * {@link PaymentIntent.recordRefund}). Same pipeline shape as the
 * other use cases: validate → replay → acquire → load → domain
 * transition → persist + journal + complete in one tx. All money
 * rules live in the aggregate; this class is pure orchestration.
 */
export class RefundPaymentUseCase {
  constructor(private readonly deps: RefundPaymentDeps) {}

  async execute(
    command: RefundPaymentCommand,
  ): Promise<Result<RefundPaymentResult, DomainError>> {
    const idempotencyKey = parseIdempotencyKey(command.idempotencyKey);
    if (!idempotencyKey.ok) return err(idempotencyKey.error);

    let amount: Money;
    try {
      amount = Money.of(command.amountMinor, command.currency);
    } catch (error) {
      return err(error as DomainError);
    }

    const completed =
      await this.deps.idempotency.getCompleted<RefundPaymentResult>(
        IDEMPOTENCY_SCOPE,
        idempotencyKey.value,
      );
    if (completed !== null) return ok(completed);

    const acquired = await this.deps.idempotency.acquire(
      IDEMPOTENCY_SCOPE,
      idempotencyKey.value,
    );
    if (acquired === 'in-progress') {
      return err(
        new RequestInProgressError(IDEMPOTENCY_SCOPE, idempotencyKey.value),
      );
    }

    try {
      const intent = await this.deps.intents.findById(command.intentId);
      if (!intent) {
        await this.deps.idempotency.release(
          IDEMPOTENCY_SCOPE,
          idempotencyKey.value,
        );
        return err(new PaymentNotFoundError(command.intentId));
      }

      try {
        intent.recordRefund(amount);
      } catch (error) {
        await this.deps.idempotency.release(
          IDEMPOTENCY_SCOPE,
          idempotencyKey.value,
        );
        return err(error as DomainError);
      }

      const result = await this.deps.unitOfWork.run(async (tx) => {
        const intents = this.deps.intents.with(tx);
        const ledger = this.deps.ledger.with(tx);
        const idempotency = this.deps.idempotency.with(tx);

        await intents.save(intent);
        await ledger.append(
          'PaymentIntent',
          intent.intentId,
          intent.pullEvents().map(serializePaymentEvent),
        );

        const out: RefundPaymentResult = {
          intentId: intent.intentId,
          status: intent.currentStatus,
          refundedToDate: intent.refundedToDate.toSnapshot(),
        };
        await idempotency.complete(
          IDEMPOTENCY_SCOPE,
          idempotencyKey.value,
          out,
        );
        return out;
      });

      return ok(result);
    } catch (error) {
      await this.deps.idempotency
        .release(IDEMPOTENCY_SCOPE, idempotencyKey.value)
        .catch(() => undefined);
      throw error;
    }
  }
}

class PaymentNotFoundError extends DomainError {
  readonly code = 'PAYMENT_INTENT_NOT_FOUND';
  constructor(intentId: string) {
    super(`Payment intent ${intentId} not found`);
  }
}
