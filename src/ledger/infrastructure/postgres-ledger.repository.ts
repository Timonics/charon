import type { LedgerRepository } from '../application/ports/ledger-repository';
import type { LedgerEntry } from '../domain/ledger-entry';
import { SequenceGapError } from '../domain/errors';
import type { SqlExecutor } from '../../shared/infrastructure/db';

/**
 * Postgres implementation of the ledger append port.
 *
 * Concurrency design (this is why the port contract is trustworthy here):
 *
 *  - Appends use INSERT ... ON CONFLICT (aggregate_id, sequence) DO NOTHING
 *    as a single multi-row statement. The unique index created in the
 *    initial migration is the serialization point: two writers racing to
 *    append the same next sequence cannot both succeed, regardless of
 *    transaction isolation level.
 *  - A shortfall in rowCount means at least one entry collided with an
 *    existing sequence — i.e. our lastSequence read was stale (concurrent
 *    writer) — and we translate that into {@link SequenceGapError}, the
 *    same failure the in-memory fake produces. The domain-level tripwire
 *    and the database-level constraint can never disagree on what a gap is.
 *
 * BIGINT note: sequence comes back from Postgres as a string (node-postgres
 * parses BIGINT to string to avoid precision loss). We convert with
 * Number.isSafeInteger validation — silently swallowing a precision bug in
 * the audit log's ordering key is not an option.
 */
export class PostgresLedgerRepository implements LedgerRepository {
  constructor(private readonly db: SqlExecutor) {}

  async lastSequence(aggregateId: string): Promise<number | undefined> {
    const result = await this.db.query(
      'SELECT max(sequence) AS max_sequence FROM ledger_entries WHERE aggregate_id = $1',
      [aggregateId],
    );
    const row = result.rows[0] as
      { max_sequence: string | number | null } | undefined;
    const max = row?.max_sequence;
    if (max === null || max === undefined) {
      return undefined;
    }
    return toSafeSequence(max);
  }

  async append(entries: readonly LedgerEntry[]): Promise<void> {
    if (entries.length === 0) {
      return;
    }

    // Contiguity check BEFORE touching the database: every entry must be
    // exactly lastSequence + 1 for its aggregate, including continuity with
    // rows already journaled. The ON CONFLICT guard below only catches
    // duplicates; skipped sequences would otherwise slip through silently.
    const byAggregate = new Map<string, LedgerEntry[]>();
    for (const entry of entries) {
      const list = byAggregate.get(entry.aggregateId) ?? [];
      list.push(entry);
      byAggregate.set(entry.aggregateId, list);
    }
    for (const [aggregateId, batch] of byAggregate) {
      let expected = ((await this.lastSequence(aggregateId)) ?? 0) + 1;
      for (const entry of batch) {
        if (entry.sequence !== expected) {
          throw new SequenceGapError(
            entry.aggregateType,
            aggregateId,
            expected,
            entry.sequence,
          );
        }
        expected += 1;
      }
    }

    // Build a multi-row INSERT with $n placeholders. One statement keeps
    // the whole batch atomic without needing an explicit transaction here —
    // a single statement is implicitly atomic in Postgres.
    const columns =
      '(entry_id, aggregate_type, aggregate_id, event_type, payload, occurred_at, recorded_at, sequence)';
    const values: unknown[] = [];
    const placeholders = entries
      .map((entry, rowIndex) => {
        const base = rowIndex * 8;
        values.push(
          entry.entryId,
          entry.aggregateType,
          entry.aggregateId,
          entry.eventType,
          JSON.stringify(entry.payload),
          entry.occurredAt,
          entry.recordedAt,
          entry.sequence,
        );
        return `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}::jsonb, $${base + 6}, $${base + 7}, $${base + 8})`;
      })
      .join(', ');

    const result = await this.db.query(
      `INSERT INTO ledger_entries ${columns} VALUES ${placeholders} ` +
        'ON CONFLICT (aggregate_id, sequence) DO NOTHING',
      values,
    );

    if (result.rowCount !== entries.length) {
      // A concurrent writer committed between our lastSequence read and
      // this insert. Translate it into the same SequenceGapError the
      // pre-check produces, so callers see one failure mode, not two.
      throw await this.describeGap(entries);
    }
  }

  /**
   * Turns a conflict shortfall into a precise {@link SequenceGapError}: find
   * the first entry whose sequence is already occupied and report what the
   * stream expected versus what arrived.
   */
  private async describeGap(
    entries: readonly LedgerEntry[],
  ): Promise<SequenceGapError> {
    const first = entries[0];
    const last = await this.lastSequence(first.aggregateId);
    const offender = entries.find((e) => e.sequence <= (last ?? 0)) ?? first;
    return new SequenceGapError(
      offender.aggregateType,
      offender.aggregateId,
      (last ?? 0) + 1,
      offender.sequence,
    );
  }

  /**
   * Returns a new repository instance bound to the given SQL executor.
   * Same-instance calls share no state — each `with()` call returns a
   * fresh object, so concurrent transactions on the same originating
   * repository cannot interfere.
   */
  with(tx: SqlExecutor): PostgresLedgerRepository {
    return new PostgresLedgerRepository(tx);
  }
}

function toSafeSequence(raw: unknown): number {
  const value = typeof raw === 'string' ? Number(raw) : (raw as number);
  if (!Number.isSafeInteger(value)) {
    throw new Error(
      `ledger sequence from database is not a safe integer: ${String(raw)}`,
    );
  }
  return value;
}
