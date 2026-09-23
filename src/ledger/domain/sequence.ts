import { SequenceGapError } from './errors';

/**
 * Per-aggregate sequence numbering for the append-only ledger.
 *
 * Every aggregate that emits ledger entries (PaymentIntent, Escrow, ...)
 * owns an independent sequence that starts at 1 and increases by exactly 1
 * per entry. The sequence is what lets consumers answer two critical
 * questions cheaply:
 *
 *  1. "Do I have every event for this aggregate?" — replay entries in
 *     sequence order; a gap is immediately visible as a missing number, and
 *     {@link assertNextSequence} makes the gap loud at write time.
 *  2. "Have I already processed this event?" — webhooks can arrive
 *     duplicated and out of order; dedupe on (aggregateId, sequence) or on
 *     the domain eventId, then order by sequence.
 *
 * The sequence is assigned by the append path (application layer) using
 * the last persisted sequence for the aggregate. It is never derived from
 * wall-clock time — concurrent writers and clock skew would make that
 * unreliable.
 */
export const FIRST_SEQUENCE = 1;

/**
 * True when `next` is the legal successor of `lastSequence`. Passing
 * `undefined` as `lastSequence` means "no entries yet" — only
 * {@link FIRST_SEQUENCE} is legal then.
 */
export function isNextSequence(
  lastSequence: number | undefined,
  next: number,
): boolean {
  return next === (lastSequence ?? 0) + 1;
}

/**
 * Write-time guard used by the append path. Throws {@link SequenceGapError}
 * unless `next` is exactly `lastSequence + 1`, so a lost or reordered event
 * fails the whole append instead of corrupting the stream.
 */
export function assertNextSequence(
  aggregateType: string,
  aggregateId: string,
  lastSequence: number | undefined,
  next: number,
): void {
  const expected = (lastSequence ?? 0) + 1;
  if (next !== expected) {
    throw new SequenceGapError(aggregateType, aggregateId, expected, next);
  }
}
