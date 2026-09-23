import { randomUUID } from 'node:crypto';

import { DomainEvent } from '../../shared/kernel/domain-event';
import type { IdempotencyKey } from '../../shared/kernel/idempotency-key';
import { Money } from '../../shared/kernel/money';
import type { ProviderName } from '../../shared/kernel/provider-name';
import {
  InvalidPaymentIntentError,
  RefundExceedsChargedAmountError,
  RefundNotAllowedError,
} from './errors';
import {
  PaymentInitiated,
  PaymentSucceeded,
  PaymentFailed,
  RefundIssued,
} from './events';
import type { PaymentMethod } from './payment-method';
import { assertLegalTransition, PaymentStatus } from './payment-status';
import type { MoneySnapshot } from '../../shared/kernel/money';

/**
 * Everything needed to construct a new {@link PaymentIntent}.
 *
 * Note that `provider` is an INPUT to construction: the router runs first
 * (a pure, separately testable decision), and its result is baked into the
 * aggregate. The provider never changes afterwards — switching providers
 * mid-intent would mean the customer's authorization was obtained from one
 * institution but the money moved through another, which is not a state
 * this service should ever be in.
 */
export interface CreatePaymentIntentInput {
  /** Charged amount. Must be positive; zero is rejected. */
  readonly amount: Money;
  readonly method: PaymentMethod;
  /** Result of routing; fixed for the life of the intent. */
  readonly provider: ProviderName;
  /** Caller-supplied key; the idempotency anchor for the whole operation. */
  readonly idempotencyKey: IdempotencyKey;
  /** Opaque reference to the caller's customer (their user id, etc.). */
  readonly customerRef?: string;
  /** Free-text purpose; audit/logging only, never branched on. */
  readonly description?: string;
}

/**
 * Plain-data snapshot of a {@link PaymentIntent}'s current state — the
 * persistence contract between the aggregate and its repository. History is
 * NOT part of the snapshot; it lives in the append-only ledger, and the
 * snapshot may always be rebuilt from there.
 */
export interface PaymentIntentSnapshot {
  readonly intentId: string;
  readonly amount: MoneySnapshot;
  readonly method: PaymentMethod;
  readonly provider: ProviderName;
  readonly idempotencyKey: IdempotencyKey;
  readonly customerRef?: string;
  readonly description?: string;
  readonly createdAt: Date;
  readonly status: PaymentStatus;
  readonly providerChargeRef?: string;
  readonly refundedAmount: MoneySnapshot;
}

/**
 * The PaymentIntent aggregate root — the Payments context's record of "a
 * customer tried to pay X via method M".
 *
 * Invariants (enforced here, in the domain layer, nowhere else):
 *
 *  1. `amount` is positive and immutable. If the amount is wrong, a new
 *     intent is created; amounts are never edited in place.
 *  2. `provider` is chosen at creation and immutable (see input type above).
 *  3. Status moves only along the {@link PaymentStatus} state machine;
 *     terminal states (SUCCEEDED / FAILED / EXPIRED) are frozen forever.
 *  4. `idempotencyKey` is recorded at creation so the application layer can
 *     deduplicate replays of the same command.
 *  5. Cumulative refunds never exceed the charged amount.
 *
 * Settlement truth: the aggregate reaches SUCCEEDED only through
 * `markSucceeded()`, which the application layer calls when a *verified*
 * provider webhook arrives — never on the synchronous "success" response of
 * a provider API call (see project anti-patterns).
 */
export class PaymentIntent {
  /**
   * Domain events produced since the last {@link pullEvents} drain.
   *
   * Events are collected in-memory and drained by the application layer
   * after a successful unit of work (which then persists them to the
   * append-only ledger). This is what makes the ledger possible without the
   * domain knowing anything about databases: the aggregate *announces* what
   * happened; persistence is someone else's job.
   */
  private domainEvents: DomainEvent[] = [];

  /** Running total of everything refunded so far; guards invariant #5. */
  private refundedAmount: Money;

  private constructor(
    /** Public identifier; safe to expose to clients and logs. */
    readonly intentId: string,
    readonly amount: Money,
    readonly method: PaymentMethod,
    readonly provider: ProviderName,
    readonly idempotencyKey: IdempotencyKey,
    readonly customerRef: string | undefined,
    readonly description: string | undefined,
    readonly createdAt: Date,
    private status: PaymentStatus,
    /** Provider's charge reference; known once the provider accepted the charge. */
    private providerChargeRef: string | undefined,
  ) {
    this.refundedAmount = Money.zero(amount.currency);
  }

  /**
   * Creates a new intent in the INITIATED state and records the
   * {@link PaymentInitiated} event. This is the ONLY way to get an intent —
   * there is no rehydration path here; rebuilding state from persistence is
   * the repository's job (infrastructure layer).
   */
  static create(input: CreatePaymentIntentInput): PaymentIntent {
    if (input.amount.isZero()) {
      throw new InvalidPaymentIntentError('amount must be positive; got zero');
    }

    const intent = new PaymentIntent(
      randomUUID(),
      input.amount,
      input.method,
      input.provider,
      input.idempotencyKey,
      input.customerRef,
      input.description,
      new Date(),
      'INITIATED',
      undefined,
    );

    intent.record(
      new PaymentInitiated(
        intent.intentId,
        intent.amount,
        intent.method,
        intent.provider,
        intent.idempotencyKey,
      ),
    );
    return intent;
  }

  /**
   * Rebuilds an aggregate from a persisted snapshot. FOR REPOSITORY USE
   * ONLY. Deliberately different from {@link PaymentIntent.create}:
   *
   *  - emits NO domain events — rehydration must never append to the
   *    journal; history was already journaled when the events first fired;
   *  - does not re-validate the state machine — the snapshot is a faithful
   *    record of a legal past, and the ledger remains the authority if the
   *    snapshot was somehow corrupted.
   */
  static fromSnapshot(snapshot: PaymentIntentSnapshot): PaymentIntent {
    const intent = new PaymentIntent(
      snapshot.intentId,
      Money.fromSnapshot(snapshot.amount),
      snapshot.method,
      snapshot.provider,
      snapshot.idempotencyKey,
      snapshot.customerRef,
      snapshot.description,
      snapshot.createdAt,
      snapshot.status,
      snapshot.providerChargeRef,
    );
    intent.refundedAmount = Money.fromSnapshot(snapshot.refundedAmount);
    return intent;
  }

  /** Plain-data snapshot of the aggregate's current state, for persistence. */
  toSnapshot(): PaymentIntentSnapshot {
    return {
      intentId: this.intentId,
      amount: this.amount.toSnapshot(),
      method: this.method,
      provider: this.provider,
      idempotencyKey: this.idempotencyKey,
      customerRef: this.customerRef,
      description: this.description,
      createdAt: this.createdAt,
      status: this.status,
      providerChargeRef: this.providerChargeRef,
      refundedAmount: this.refundedAmount.toSnapshot(),
    };
  }

  // ------------------------------------------------------------------ //
  // Read-only accessors                                                 //
  // ------------------------------------------------------------------ //

  get currentStatus(): PaymentStatus {
    return this.status;
  }

  get chargeReference(): string | undefined {
    return this.providerChargeRef;
  }

  /** Cumulative refunded amount (zero when nothing has been refunded). */
  get refundedToDate(): Money {
    return this.refundedAmount;
  }

  /** Money still held after refunds; the escrow context cares about this. */
  get availableAmount(): Money {
    return this.amount.subtract(this.refundedAmount);
  }

  // ------------------------------------------------------------------ //
  // Lifecycle commands — each guards the state machine, then records an event //
  // ------------------------------------------------------------------ //

  /**
   * The provider has accepted the charge and it is now in flight
   * (authorization/capture pending). Records the provider's charge reference
   * because from this point on it is the reconciliation key for webhooks.
   */
  markProcessing(providerChargeRef: string): void {
    assertLegalTransition(this.status, 'PROCESSING');
    if (!providerChargeRef || providerChargeRef.trim().length === 0) {
      throw new InvalidPaymentIntentError(
        'providerChargeRef must be a non-empty string',
      );
    }
    this.status = 'PROCESSING';
    this.providerChargeRef = providerChargeRef;
  }

  /**
   * Verified webhook confirmed settlement. Only legal from PROCESSING.
   * This is the ONLY way an intent becomes SUCCEEDED.
   */
  markSucceeded(): void {
    assertLegalTransition(this.status, 'SUCCEEDED');
    this.status = 'SUCCEEDED';
    // Non-null asserted by the state machine: SUCCEEDED is only reachable
    // from PROCESSING, which requires a charge reference.
    this.record(
      new PaymentSucceeded(this.intentId, this.amount, this.providerChargeRef!),
    );
  }

  /** The charge definitively failed. `reason` is audit-only free text. */
  markFailed(reason?: string): void {
    assertLegalTransition(this.status, 'FAILED');
    this.status = 'FAILED';
    this.record(new PaymentFailed(this.intentId, reason));
  }

  /**
   * The authorization lapsed without settlement (provider-side expiry, or
   * our own TTL sweep). Distinct from FAILED: no failure occurred, the
   * money simply never moved.
   */
  expire(): void {
    assertLegalTransition(this.status, 'EXPIRED');
    this.status = 'EXPIRED';
  }

  /**
   * Records a (possibly partial) refund against a SUCCEEDED intent.
   *
   * Invariants enforced:
   *  - status must be SUCCEEDED — we only refund webhook-confirmed money;
   *  - `amount` must be positive (Money already guarantees non-negative;
   *    zero is rejected as a pointless no-op that would pollute the ledger);
   *  - currency must match the charged currency (Money.add throws
   *    {@link CurrencyMismatchError} otherwise);
   *  - refundedAmount + amount ≤ charged amount — the core anti-double-refund
   *    guard. It makes "refund everything twice on retry" impossible at the
   *    domain level even if the application layer's idempotency check fails.
   *
   * The intent stays SUCCEEDED even when fully refunded — "refunded" is a
   * ledger fact (RefundIssued events), not a status rewrite. History is
   * append-only.
   */
  recordRefund(amount: Money): void {
    if (this.status !== 'SUCCEEDED') {
      throw new RefundNotAllowedError(this.status);
    }
    if (amount.isZero()) {
      throw new InvalidPaymentIntentError(
        'refund amount must be positive; got zero',
      );
    }

    const newTotal = this.refundedAmount.add(amount);
    if (newTotal.isGreaterThan(this.amount)) {
      throw new RefundExceedsChargedAmountError(
        this.amount.amount,
        this.refundedAmount.amount,
        amount.amount,
      );
    }

    this.refundedAmount = newTotal;
    this.record(new RefundIssued(this.intentId, amount, this.refundedAmount));
  }

  // ------------------------------------------------------------------ //
  // Event collection                                                    //
  // ------------------------------------------------------------------ //

  /**
   * Returns the accumulated domain events and clears the internal buffer.
   * Called exactly once per successful application-layer transaction, after
   * which the events are appended to the ledger. Draining (rather than
   * peeking) prevents the same event from being persisted twice.
   */
  pullEvents(): DomainEvent[] {
    const drained = this.domainEvents;
    this.domainEvents = [];
    return drained;
  }

  /** Appends an event to the in-memory buffer. Single chokepoint for event creation. */
  private record(event: DomainEvent): void {
    this.domainEvents.push(event);
  }
}
