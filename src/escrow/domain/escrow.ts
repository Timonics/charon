import { randomUUID } from 'node:crypto';

import { DomainEvent } from '../../shared/kernel/domain-event';
import { Money, type MoneySnapshot } from '../../shared/kernel/money';
import type { ProviderName } from '../../shared/kernel/provider-name';
import type { TenantId } from '../../shared/kernel/tenant';
import {
  InvalidEscrowOperationError,
  IllegalEscrowStateTransitionError,
} from './errors';
import { assertLegalEscrowTransition, EscrowState } from './escrow-state';
import {
  EscrowCancelled,
  EscrowDisputed,
  EscrowExpired,
  EscrowHeld,
  EscrowInitiated,
  EscrowReleased,
  EscrowRefunded,
  EscrowResolved,
  Refund,
  Release,
} from './events';

/**
 * Everything needed to register a new escrow against a payment intent.
 */
export interface CreateEscrowInput {
  /**
   * Identity reference to the settled payment intent — stored as a plain
   * string id so the Escrow context never imports the Payments context's
   * types (cross-context references are by identity, per DDD).
   */
  readonly paymentIntentId: string;
  /**
   * The Cerberus Organization UUID that owns this escrow. Required —
   * mirrors the same tenancy invariant as `PaymentIntent.tenantId`
   * (every payment has a tenant; every escrow is held against a
   * payment, so the escrow inherits the payment's tenant). Use
   * case asserts ownership before every state-changing call.
   */
  readonly tenantId: TenantId;
  /** The amount to be held. Must be positive; fixed for the life of the escrow. */
  readonly heldAmount: Money;
  /** Provider whose custody primitive secures the hold. */
  readonly provider: ProviderName;
  /** Optional caller reference for correlation in their system. */
  readonly externalRef?: string;
}

/**
 * Plain-data snapshot of an {@link Escrow}'s current state — the
 * persistence contract between the aggregate and its repository. Movement
 * history is not duplicated here; it lives in the append-only ledger.
 *
 * `version` is the optimistic-concurrency token. The repository bumps
 * it on every successful UPDATE; the in-memory aggregate carries the
 * value it loaded at read time, and the save() compare-and-swap
 * throws OptimisticLockError if the row's version no longer matches.
 * Without this, two concurrent release-escrow calls can both pass
 * the in-memory invariant check and over-release a held amount.
 */
export interface EscrowSnapshot {
  readonly escrowId: string;
  /** Tenant ownership. Mirrored from the underlying PaymentIntent. */
  readonly tenantId: TenantId;
  readonly paymentIntentId: string;
  readonly heldAmount: MoneySnapshot;
  readonly provider: ProviderName;
  readonly externalRef?: string;
  readonly createdAt: Date;
  readonly state: EscrowState;
  readonly providerCustodyRef?: string;
  readonly releasedAmount: MoneySnapshot;
  readonly refundedAmount: MoneySnapshot;
  readonly version: number;
}

/**
 * The Escrow aggregate root: a hold over a settled payment, tracked as an
 * explicit state machine with partial releases built in from day one.
 *
 * What this aggregate IS: the authoritative record of "how much of this
 * hold is still unspent, and what movements have happened". Every movement
 * is an immutable line entity (Release/Refund) plus a domain event.
 *
 * What this aggregate IS NOT: a custodian. Funds sit with the licensed
 * provider's own subaccount/split primitive; this service only orchestrates
 * and records. `providerCustodyRef` names the provider-side structure — it
 * is recorded and audited, never manipulated directly here.
 *
 * Core invariant, enforced on every movement:
 *
 *      sum(releases) + sum(refunds) ≤ heldAmount
 *
 * Stated as: each movement may consume at most `availableAmount()` =
 * held − released − refunded. Combined with Money's non-negativity and
 * currency matching, double-spending a hold is impossible at the domain
 * level even if every upstream check fails.
 */
export class Escrow {
  private domainEvents: DomainEvent[] = [];

  /** Immutable movement history. Exposed read-only; never mutated in place. */
  private readonly releases: Release[] = [];
  private readonly refunds: Refund[] = [];

  /** Running totals; the invariant is checked against these. */
  private releasedAmount: Money;
  private refundedAmount: Money;

  private state: EscrowState;

  /** Provider-side custody reference; known once the hold is confirmed. */
  private providerCustodyRef: string | undefined;

  /**
   * Optimistic-concurrency token. Set from the snapshot on rehydration
   * (the row's current version), default 0 for new aggregates. Bumped
   * after every state-changing call via {@link record}.
   */
  private version: number;

  private constructor(
    readonly escrowId: string,
    /**
     * The Cerberus Organization UUID that owns this escrow. Set
     * at creation from the underlying PaymentIntent's tenantId
     * and never changes for the life of the aggregate. Use case
     * asserts `principal.tenantId === this.tenantId` before every
     * state-changing call.
     */
    readonly tenantId: TenantId,
    readonly paymentIntentId: string,
    readonly heldAmount: Money,
    readonly provider: ProviderName,
    readonly externalRef: string | undefined,
    readonly createdAt: Date,
    initialState: EscrowState,
    initialVersion: number = 0,
  ) {
    this.releasedAmount = Money.zero(heldAmount.currency);
    this.refundedAmount = Money.zero(heldAmount.currency);
    this.state = initialState;
    this.version = initialVersion;
  }

  /**
   * Registers a new escrow in the PENDING state. This is the ONLY way to
   * create one; rehydration from persistence is the repository's job.
   */
  static create(input: CreateEscrowInput): Escrow {
    if (input.heldAmount.isZero()) {
      throw new InvalidEscrowOperationError(
        'held amount must be positive; got zero',
      );
    }
    if (!input.paymentIntentId || input.paymentIntentId.trim().length === 0) {
      throw new InvalidEscrowOperationError(
        'paymentIntentId must be a non-empty string',
      );
    }

    const escrow = new Escrow(
      randomUUID(),
      input.tenantId,
      input.paymentIntentId,
      input.heldAmount,
      input.provider,
      input.externalRef,
      new Date(),
      'PENDING',
    );
    escrow.record(
      new EscrowInitiated(
        escrow.escrowId,
        escrow.paymentIntentId,
        escrow.heldAmount,
        escrow.provider,
      ),
    );
    return escrow;
  }

  /**
   * Rebuilds an aggregate from a persisted snapshot. FOR REPOSITORY USE
   * ONLY — same contract as {@link PaymentIntent.fromSnapshot}: no events
   * emitted, no state-machine re-validation.
   *
   * Movement lines are intentionally NOT part of the snapshot: the
   * running totals carry every invariant, and the individual Release/Refund
   * history lives in the append-only ledger, which remains the authority.
   */
  static fromSnapshot(snapshot: EscrowSnapshot): Escrow {
    const escrow = new Escrow(
      snapshot.escrowId,
      snapshot.tenantId,
      snapshot.paymentIntentId,
      Money.fromSnapshot(snapshot.heldAmount),
      snapshot.provider,
      snapshot.externalRef,
      snapshot.createdAt,
      snapshot.state,
      snapshot.version,
    );
    escrow.providerCustodyRef = snapshot.providerCustodyRef;
    escrow.releasedAmount = Money.fromSnapshot(snapshot.releasedAmount);
    escrow.refundedAmount = Money.fromSnapshot(snapshot.refundedAmount);
    return escrow;
  }

  /** Plain-data snapshot of the aggregate's current state, for persistence. */
  toSnapshot(): EscrowSnapshot {
    return {
      escrowId: this.escrowId,
      tenantId: this.tenantId,
      paymentIntentId: this.paymentIntentId,
      heldAmount: this.heldAmount.toSnapshot(),
      provider: this.provider,
      externalRef: this.externalRef,
      createdAt: this.createdAt,
      state: this.state,
      providerCustodyRef: this.providerCustodyRef,
      releasedAmount: this.releasedAmount.toSnapshot(),
      refundedAmount: this.refundedAmount.toSnapshot(),
      version: this.version,
    };
  }

  // ------------------------------------------------------------------ //
  // Read-only accessors                                                 //
  // ------------------------------------------------------------------ //

  get currentState(): EscrowState {
    return this.state;
  }

  get custodyReference(): string | undefined {
    return this.providerCustodyRef;
  }

  get releasedToDate(): Money {
    return this.releasedAmount;
  }

  get refundedToDate(): Money {
    return this.refundedAmount;
  }

  /**
   * The unspent remainder of the hold — the most important number in this
   * aggregate. Every movement is bounded by it; escrow release use cases
   * read it to refuse over-release before the domain even has to.
   */
  get availableAmount(): Money {
    return this.heldAmount.subtract(
      this.releasedAmount.add(this.refundedAmount),
    );
  }

  // ------------------------------------------------------------------ //
  // Lifecycle commands                                                  //
  // ------------------------------------------------------------------ //

  /**
   * Confirms that the charge settled (webhook-driven, via the application
   * layer) and the provider's custody primitive is in place. PENDING → HELD.
   * No funds may move before this.
   */
  hold(providerCustodyRef: string): void {
    assertLegalEscrowTransition(this.state, 'HELD');
    if (!providerCustodyRef || providerCustodyRef.trim().length === 0) {
      throw new InvalidEscrowOperationError(
        'providerCustodyRef must be a non-empty string',
      );
    }
    this.state = 'HELD';
    this.providerCustodyRef = providerCustodyRef;
    this.record(
      new EscrowHeld(this.escrowId, this.heldAmount, providerCustodyRef),
    );
  }

  /**
   * Releases (part of) the hold to its destination — the marketplace payout
   * step. Partial releases are first-class: the escrow stays HELD until the
   * hold is fully consumed, so a 70/30 split is just two calls.
   *
   * Rules:
   *  - state must be HELD (DISPUTED freezes releases; terminal states reject);
   *  - amount must be positive and match the held currency (Money enforces);
   *  - amount must not exceed availableAmount() — the core invariant;
   *  - if this release consumes the remainder, the escrow transitions to
   *    RELEASED: the state records HOW the hold ended.
   */
  release(amount: Money, recipientRef?: string, note?: string): void {
    if (this.state !== 'HELD') {
      throw new IllegalEscrowStateTransitionError(this.state, 'RELEASED');
    }
    this.assertSpendable(amount);

    const line = new Release(amount, recipientRef, note, new Date());
    this.releases.push(line);
    this.releasedAmount = this.releasedAmount.add(amount);

    if (this.availableAmount.isZero()) {
      assertLegalEscrowTransition(this.state, 'RELEASED');
      this.state = 'RELEASED';
    }
    this.record(
      new EscrowReleased(
        this.escrowId,
        line.releaseId,
        amount,
        this.releasedAmount,
        recipientRef,
      ),
    );
  }

  /**
   * Refunds (part of) the hold back to the payer. Same rules as
   * {@link Escrow.release}; if the refund consumes the remainder, the
   * escrow transitions to REFUNDED. A hold closed by a final refund is
   * REFUNDED even if earlier partial releases occurred — the terminal state
   * records the action that ended the hold.
   */
  refund(amount: Money, note?: string): void {
    if (this.state !== 'HELD') {
      throw new IllegalEscrowStateTransitionError(this.state, 'REFUNDED');
    }
    this.assertSpendable(amount);

    const line = new Refund(amount, note, new Date());
    this.refunds.push(line);
    this.refundedAmount = this.refundedAmount.add(amount);

    if (this.availableAmount.isZero()) {
      assertLegalEscrowTransition(this.state, 'REFUNDED');
      this.state = 'REFUNDED';
    }
    this.record(
      new EscrowRefunded(
        this.escrowId,
        line.refundId,
        amount,
        this.refundedAmount,
      ),
    );
  }

  /**
   * Freezes the hold: no releases or refunds until resolved. Only from
   * HELD — disputing a PENDING escrow (nothing held) or a terminal escrow
   * (nothing left) is meaningless.
   */
  dispute(reason: string): void {
    assertLegalEscrowTransition(this.state, 'DISPUTED');
    if (!reason || reason.trim().length === 0) {
      throw new InvalidEscrowOperationError(
        'dispute reason must be a non-empty string',
      );
    }
    this.state = 'DISPUTED';
    this.record(new EscrowDisputed(this.escrowId, reason));
  }

  /** Lifts the freeze; movement resumes from wherever it left off. */
  resolveDispute(): void {
    assertLegalEscrowTransition(this.state, 'HELD');
    this.state = 'HELD';
    this.record(new EscrowResolved(this.escrowId));
  }

  /**
   * Abandons an unsettled escrow (its charge failed or was voided). Only
   * legal from PENDING — a HELD escrow's funds are real and must leave via
   * release or refund, never by deletion-style cancellation.
   */
  cancel(reason?: string): void {
    assertLegalEscrowTransition(this.state, 'CANCELLED');
    this.state = 'CANCELLED';
    this.record(new EscrowCancelled(this.escrowId, reason));
  }

  /**
   * Time-bound lapse: the booking window for a PENDING escrow expired before
   * the charge settled. Distinct from cancel() so the audit trail preserves
   * the cause — a clock vs. a human decision is materially different in
   * reconciliation reviews. Only legal from PENDING.
   */
  expire(reason?: string): void {
    assertLegalEscrowTransition(this.state, 'EXPIRED');
    this.state = 'EXPIRED';
    this.record(new EscrowExpired(this.escrowId, reason));
  }

  // ------------------------------------------------------------------ //
  // Event collection                                                    //
  // ------------------------------------------------------------------ //

  /**
   * Returns and clears the accumulated domain events. Called once per
   * committed application transaction, after which events are journaled by
   * the LedgerAppender. Identical drain semantics to PaymentIntent.
   */
  pullEvents(): DomainEvent[] {
    const drained = this.domainEvents;
    this.domainEvents = [];
    return drained;
  }

  private record(event: DomainEvent): void {
    this.domainEvents.push(event);
  }

  /**
   * Shared spend validation for release and refund: positive amount, and
   * the cumulative-consumption invariant. Money.add throws on currency
   * mismatch before we even get here.
   */
  private assertSpendable(amount: Money): void {
    if (amount.isZero()) {
      throw new InvalidEscrowOperationError(
        'amount must be positive; got zero',
      );
    }
    const consumed = this.releasedAmount.add(this.refundedAmount).add(amount);
    if (consumed.isGreaterThan(this.heldAmount)) {
      throw new InvalidEscrowOperationError(
        `movement of ${amount.toString()} exceeds available ${this.availableAmount.toString()} ` +
          `on hold of ${this.heldAmount.toString()}`,
      );
    }
  }
}
