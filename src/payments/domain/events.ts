import { DomainEvent } from '../../shared/kernel/domain-event';
import type { IdempotencyKey } from '../../shared/kernel/idempotency-key';
import { Money } from '../../shared/kernel/money';
import type { ProviderName } from '../../shared/kernel/provider-name';
import type { PaymentMethod } from './payment-method';

/**
 * Emitted once, when a {@link PaymentIntent} is first recorded and handed to
 * a provider. This is the earliest point at which money movement is even
 * *possible*, so the ledger starts its trail here.
 */
export class PaymentInitiated extends DomainEvent {
  readonly eventType = 'PaymentInitiated';

  constructor(
    readonly intentId: string,
    /** Amount the customer authorized. Immutable for the life of the intent. */
    readonly amount: Money,
    readonly method: PaymentMethod,
    /** Provider chosen by the router at creation; never changes afterwards. */
    readonly provider: ProviderName,
    readonly idempotencyKey: IdempotencyKey,
  ) {
    super();
  }
}

/**
 * Emitted when the verified provider webhook confirms settlement. This — not
 * the provider's synchronous API response — is the moment we consider the
 * money real. Name is "Succeeded" rather than "Settled" to stay aligned with
 * provider event vocabulary, but treat it as a settlement confirmation.
 */
export class PaymentSucceeded extends DomainEvent {
  readonly eventType = 'PaymentSucceeded';

  constructor(
    readonly intentId: string,
    readonly amount: Money,
    /** Provider's own reference for the charge; the reconciliation key. */
    readonly providerChargeRef: string,
  ) {
    super();
  }
}

/**
 * Emitted when the charge definitively failed (provider failure webhook,
 * explicit failure response confirmed downstream, or expiry). `reason` is
 * free text from the provider; keep it for audit but never branch on it.
 */
export class PaymentFailed extends DomainEvent {
  readonly eventType = 'PaymentFailed';

  constructor(
    readonly intentId: string,
    readonly reason?: string,
  ) {
    super();
  }
}

/**
 * Emitted per refund, including partial refunds. The aggregate guarantees
 * (via invariant) that the cumulative `refundedToDate` never exceeds the
 * charged amount, so consumers can trust this number without re-deriving it.
 */
export class RefundIssued extends DomainEvent {
  readonly eventType = 'RefundIssued';

  constructor(
    readonly intentId: string,
    /** Amount of THIS refund (not cumulative). */
    readonly amount: Money,
    /** Cumulative refunded amount across all refunds on this intent. */
    readonly refundedToDate: Money,
  ) {
    super();
  }
}
