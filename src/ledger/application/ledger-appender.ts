import { LedgerEntry } from '../../ledger/domain/ledger-entry';
import { assertNextSequence } from '../../ledger/domain/sequence';
import type { LedgerRepository } from './ports/ledger-repository';
import type { SqlExecutor } from '../../shared/infrastructure/db';

/**
 * A domain event reduced to the journaled form: its type, when it occurred,
 * and a JSON-safe payload. Serialization is the CALLER's job (each context
 * knows how to flatten its own events — see payments/application/
 * event-serializer.ts); the appender stays context-independent so the
 * Ledger context never imports Payments or Escrow types.
 */
export interface AppendableEvent {
  readonly eventType: string;
  readonly occurredAt: Date;
  readonly payload: unknown;
}

/**
 * The single code path that turns drained domain events into journaled
 * {@link LedgerEntry}s.
 *
 * Responsibilities:
 *  - read the aggregate's last persisted sequence and assign strictly
 *    increasing sequence numbers to the new events, in order;
 *  - validate continuity with {@link assertNextSequence} so a stale read or
 *    concurrent writer fails loudly here (with SequenceGapError) instead of
 *    leaving a silent gap;
 *  - hand the batch to the repository, whose atomic-append contract makes
 *    the whole batch land or none of it.
 *
 * Nothing else in the service writes to the ledger. If a new use case needs
 * to journal events, it goes through this appender.
 */
export class LedgerAppender {
  constructor(private readonly ledger: LedgerRepository) {}

  /**
   * Appends drained events to the journal. The originating repository's
   * executor receives the writes — i.e. the append runs OUTSIDE any
   * transaction the caller hasn't established yet.
   *
   * To append inside a unit-of-work transaction, call {@link with} first
   * to get a tx-bound appender, then call append on that.
   */
  async append(
    aggregateType: string,
    aggregateId: string,
    events: readonly AppendableEvent[],
  ): Promise<void> {
    return this.appendWith(this.ledger, aggregateType, aggregateId, events);
  }

  /**
   * Returns a new appender bound to the given SQL executor. The returned
   * appender routes its writes through `tx`, so a use-case wrapped in a
   * unit-of-work can call `ledger.with(tx).append(...)` and have the
   * ledger write land in the same transaction as the snapshot save.
   *
   * The originating appender is unchanged; concurrent use-cases on the
   * same originating appender cannot interfere with each other.
   */
  with(tx: SqlExecutor): LedgerAppender {
    return new LedgerAppender(this.ledger.with(tx));
  }

  /**
   * Internal: shared append implementation. Receives the repository
   * directly so the public `append` (no tx) and `with(tx).append` paths
   * share the same logic without going through indirection.
   */
  private async appendWith(
    repository: LedgerRepository,
    aggregateType: string,
    aggregateId: string,
    events: readonly AppendableEvent[],
  ): Promise<void> {
    // Draining exactly once per command means this is normally 1–2 events;
    // the empty case is a legitimate no-op (e.g. a command that changed
    // nothing), not an error.
    if (events.length === 0) {
      return;
    }

    let lastSequence = await repository.lastSequence(aggregateId);
    const entries: LedgerEntry[] = [];

    for (const event of events) {
      const sequence = (lastSequence ?? 0) + 1;
      assertNextSequence(aggregateType, aggregateId, lastSequence, sequence);
      entries.push(
        LedgerEntry.record({
          aggregateType,
          aggregateId,
          eventType: event.eventType,
          payload: event.payload,
          occurredAt: event.occurredAt,
          sequence,
        }),
      );
      lastSequence = sequence;
    }

    await repository.append(entries);
  }
}
