import { DomainError } from '../../shared/kernel/domain-error';
import type { ProviderName } from '../../shared/kernel/provider-name';

/**
 * The closed set of internal event types. Each provider adapter maps its
 * native event catalog onto this enum AFTER verifying the webhook signature
 * — domain code only ever sees these, never 'charge.success' or
 * 'transfer.completed'.
 *
 * Deliberately closed: an unrecognized provider event must be logged and
 * rejected by the adapter (see project anti-patterns), never passed through
 * as free text for downstream code to guess at. Adding a type here is a code
 * change that forces handling to be written.
 *
 * Note the scope split: CHARGE_* events are consumed by the Payments
 * context; TRANSFER_* events will be consumed by the Escrow context (release
 * settlement). REFUND_COMPLETED confirms provider-side refunds.
 */
export const NORMALIZED_EVENT_TYPES = [
  'CHARGE_SUCCEEDED',
  'CHARGE_FAILED',
  'REFUND_COMPLETED',
  'TRANSFER_COMPLETED',
  'TRANSFER_FAILED',
] as const;

export type NormalizedEventType = (typeof NORMALIZED_EVENT_TYPES)[number];

export class InvalidNormalizedEventError extends DomainError {
  readonly code = 'INVALID_NORMALIZED_EVENT';

  constructor(reason: string) {
    super(`Invalid normalized payment event: ${reason}`);
  }
}

/**
 * The one internal shape every provider webhook collapses into after
 * signature verification. This is the boundary between "untrusted provider
 * payload" and "trusted internal fact":
 *
 *  - IN:  raw bytes + headers, verified per-provider (Stripe signed
 *         headers, Paystack HMAC SHA512, Flutterwave secret hash).
 *  - OUT: this object — which the application layer may act on.
 *
 * `providerRef` is the adapter's best reconciliation key (charge id,
 * transaction id, transfer id) and is how use cases locate the internal
 * aggregate the event belongs to. `raw` preserves the original payload for
 * audit and replay; it is never used for business decisions.
 *
 * Amount fields are optional because not every event type carries them
 * (failures often don't); consumers MUST treat absent amounts as "unknown",
 * never as zero.
 */
export class NormalizedPaymentEvent {
  /** Provider's own event/delivery id — the webhook deduplication key. */
  readonly eventId: string;
  readonly provider: ProviderName;
  readonly type: NormalizedEventType;
  /** Provider reference to the charge/transfer this event concerns. */
  readonly providerRef: string;
  /** When the provider says the event occurred. */
  readonly occurredAt: Date;
  /** Optional amount in minor units; absent means "not provided". */
  readonly amountMinor?: number;
  /** Optional currency code; absent means "not provided". */
  readonly currency?: string;
  /** Optional failure explanation for *_FAILED events; audit-only text. */
  readonly failureReason?: string;
  /** Original provider payload, preserved verbatim for audit/replay. */
  readonly raw?: unknown;

  constructor(input: {
    eventId: string;
    provider: ProviderName;
    type: NormalizedEventType;
    providerRef: string;
    occurredAt: Date;
    amountMinor?: number;
    currency?: string;
    failureReason?: string;
    raw?: unknown;
  }) {
    if (!input.eventId || input.eventId.trim().length === 0) {
      throw new InvalidNormalizedEventError('eventId must be non-empty');
    }
    if (!input.providerRef || input.providerRef.trim().length === 0) {
      throw new InvalidNormalizedEventError('providerRef must be non-empty');
    }
    if (
      !(input.occurredAt instanceof Date) ||
      Number.isNaN(input.occurredAt.getTime())
    ) {
      throw new InvalidNormalizedEventError('occurredAt must be a valid Date');
    }
    if (
      input.amountMinor !== undefined &&
      (!Number.isSafeInteger(input.amountMinor) || input.amountMinor < 0)
    ) {
      throw new InvalidNormalizedEventError(
        `amountMinor must be a non-negative safe integer, got ${input.amountMinor}`,
      );
    }
    if (input.amountMinor !== undefined && input.currency === undefined) {
      throw new InvalidNormalizedEventError(
        'currency is required whenever amountMinor is present',
      );
    }

    this.eventId = input.eventId;
    this.provider = input.provider;
    this.type = input.type;
    this.providerRef = input.providerRef;
    this.occurredAt = input.occurredAt;
    this.amountMinor = input.amountMinor;
    this.currency = input.currency;
    this.failureReason = input.failureReason;
    this.raw = input.raw;
  }
}
