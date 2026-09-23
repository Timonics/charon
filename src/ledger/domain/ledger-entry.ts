import { randomUUID } from 'node:crypto';

import { InvalidLedgerEntryError } from './errors';

/**
 * Everything the append path must supply to record one entry. The sequence
 * is an explicit input (never computed here) because only the append path
 * knows the last persisted sequence for the aggregate — see
 * {@link assertNextSequence}.
 */
export interface RecordLedgerEntryInput {
  /** Which kind of aggregate emitted the event, e.g. 'PaymentIntent'. */
  readonly aggregateType: string;
  /** The emitting aggregate's identity (its UUID). */
  readonly aggregateId: string;
  /** The domain event's type name, e.g. 'PaymentSucceeded'. */
  readonly eventType: string;
  /** JSON-serializable event payload as persisted. */
  readonly payload: unknown;
  /** When the domain event occurred (from the event itself, not "now"). */
  readonly occurredAt: Date;
  /** Per-aggregate sequence; must be exactly last + 1. */
  readonly sequence: number;
}

/**
 * A single immutable record in the append-only ledger — the service's
 * source of truth for "what happened" to any monetary aggregate.
 *
 * Append-only means:
 *  - entries are INSERTed, never UPDATEd or DELETEd;
 *  - corrections are new entries (e.g. a RefundIssued entry, not a rewrite
 *    of the ChargeSucceeded entry);
 *  - current state (balances, statuses) is always a *projection* derived by
 *    replaying entries, never written directly.
 *
 * Immutability is enforced in-process too: the entry is deep-frozen at
 * construction, and the payload is validated to be JSON-serializable so an
 * unserializable object (function, bigint, circular structure) fails loudly
 * here instead of at the database driver, where it might fail *after* a
 * partial write.
 */
export class LedgerEntry {
  /** Globally unique entry identifier (primary key in persistence). */
  readonly entryId: string = randomUUID();
  /** When the entry was journaled; distinct from occurredAt (event time). */
  readonly recordedAt: Date;

  readonly aggregateType: string;
  readonly aggregateId: string;
  readonly eventType: string;
  readonly payload: unknown;
  readonly occurredAt: Date;
  readonly sequence: number;

  private constructor(input: RecordLedgerEntryInput) {
    LedgerEntry.validate(input);

    this.aggregateType = input.aggregateType;
    this.aggregateId = input.aggregateId;
    this.eventType = input.eventType;
    this.payload = deepFreeze(structuredClone(input.payload));
    this.occurredAt = input.occurredAt;
    this.sequence = input.sequence;
    this.recordedAt = new Date();

    deepFreeze(this);
  }

  /**
   * The ONLY way to create an entry. There is no factory that accepts a
   * caller-supplied entryId or recordedAt — those are journal-generated,
   * and letting callers supply them would undermine the audit trail.
   */
  static record(input: RecordLedgerEntryInput): LedgerEntry {
    return new LedgerEntry(input);
  }

  private static validate(input: RecordLedgerEntryInput): void {
    for (const [field, value] of [
      ['aggregateType', input.aggregateType],
      ['aggregateId', input.aggregateId],
      ['eventType', input.eventType],
    ] as const) {
      if (typeof value !== 'string' || value.trim().length === 0) {
        throw new InvalidLedgerEntryError(
          `${field} must be a non-empty string`,
        );
      }
    }

    if (
      !(input.occurredAt instanceof Date) ||
      Number.isNaN(input.occurredAt.getTime())
    ) {
      throw new InvalidLedgerEntryError('occurredAt must be a valid Date');
    }

    if (!Number.isSafeInteger(input.sequence) || input.sequence < 1) {
      throw new InvalidLedgerEntryError(
        `sequence must be a safe integer >= 1, got ${input.sequence}`,
      );
    }

    // Structured-clone-then-serialize: catches bigint, functions, symbols,
    // circular structures, and undefined-in-place — none of which belong in
    // an audit log that outlives this process and may be consumed by other
    // languages.
    try {
      const serialized = JSON.stringify(structuredClone(input.payload));
      if (serialized === undefined) {
        throw new InvalidLedgerEntryError('payload must be JSON-serializable');
      }
    } catch (error) {
      if (error instanceof InvalidLedgerEntryError) throw error;
      throw new InvalidLedgerEntryError(
        `payload must be JSON-serializable: ${(error as Error).message}`,
      );
    }
  }
}

/**
 * Recursively freezes an object graph so accidental mutation of a journaled
 * payload is impossible (throws in strict mode) rather than silent.
 */
function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const key of Object.keys(value)) {
      deepFreeze((value as Record<string, unknown>)[key]);
    }
    Object.freeze(value);
  }
  return value;
}
