import { randomUUID } from 'node:crypto';

import { Money } from '../../shared/kernel/money';
import type { ProviderName } from '../../shared/kernel/provider-name';
import { DomainEvent } from '../../shared/kernel/domain-event';

/**
 * Emitted when an escrow is registered against a payment intent. The escrow
 * does not hold funds yet — this is the intent to hold, journaled so the
 * full lifecycle of the hold is reconstructable.
 */
export class EscrowInitiated extends DomainEvent {
  readonly eventType = 'EscrowInitiated';

  constructor(
    readonly escrowId: string,
    /** Identity reference to the Payments context's intent — by ID only, never an object, so the contexts stay decoupled. */
    readonly paymentIntentId: string,
    readonly heldAmount: Money,
    /** The provider whose custody primitive (subaccount/split) secures the hold. */
    readonly provider: ProviderName,
  ) {
    super();
  }
}

/**
 * Emitted when settlement is webhook-confirmed and the provider's custody
 * primitive is in place. Only from this point on may funds move.
 */
export class EscrowHeld extends DomainEvent {
  readonly eventType = 'EscrowHeld';

  constructor(
    readonly escrowId: string,
    readonly heldAmount: Money,
    /** Reference to the provider subaccount/split securing the funds. */
    readonly providerCustodyRef: string,
  ) {
    super();
  }
}

/** Emitted per partial release (also for the final one). */
export class EscrowReleased extends DomainEvent {
  readonly eventType = 'EscrowReleased';

  constructor(
    readonly escrowId: string,
    readonly releaseId: string,
    /** Amount of THIS release (not cumulative). */
    readonly amount: Money,
    /** Cumulative released amount across all releases on this escrow. */
    readonly releasedToDate: Money,
    /** Optional recipient reference (e.g. seller subaccount) for audit. */
    readonly recipientRef?: string,
  ) {
    super();
  }
}

/** Emitted per partial refund back to the payer (also for the final one). */
export class EscrowRefunded extends DomainEvent {
  readonly eventType = 'EscrowRefunded';

  constructor(
    readonly escrowId: string,
    readonly refundId: string,
    readonly amount: Money,
    readonly refundedToDate: Money,
  ) {
    super();
  }
}

/** Emitted when a hold is frozen pending dispute resolution. */
export class EscrowDisputed extends DomainEvent {
  readonly eventType = 'EscrowDisputed';

  constructor(
    readonly escrowId: string,
    readonly reason: string,
  ) {
    super();
  }
}

/** Emitted when a dispute is resolved and the hold returns to HELD. */
export class EscrowResolved extends DomainEvent {
  readonly eventType = 'EscrowResolved';

  constructor(readonly escrowId: string) {
    super();
  }
}

/** Emitted when a PENDING escrow is cancelled (its charge never settled). */
export class EscrowCancelled extends DomainEvent {
  readonly eventType = 'EscrowCancelled';

  constructor(
    readonly escrowId: string,
    readonly reason?: string,
  ) {
    super();
  }
}

/**
 * Emitted when a PENDING escrow's booking window lapses before settlement
 * (time-bound hold that the operator never confirmed). The aggregate stays
 * in the EXPIRED state forever; the underlying payment intent is a separate
 * concern that the payments context handles.
 */
export class EscrowExpired extends DomainEvent {
  readonly eventType = 'EscrowExpired';

  constructor(
    readonly escrowId: string,
    readonly reason?: string,
  ) {
    super();
  }
}

/**
 * A single release movement within an escrow. Immutable; corrections are
 * new releases (or refunds), never edits — same append-only philosophy as
 * the ledger itself.
 */
export class Release {
  readonly releaseId: string = randomUUID();

  constructor(
    readonly amount: Money,
    readonly recipientRef: string | undefined,
    readonly note: string | undefined,
    readonly createdAt: Date,
  ) {}
}

/** A single refund movement within an escrow. See {@link Release}. */
export class Refund {
  readonly refundId: string = randomUUID();

  constructor(
    readonly amount: Money,
    readonly note: string | undefined,
    readonly createdAt: Date,
  ) {}
}
