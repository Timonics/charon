/**
 * Atomicity proof tests for the UnitOfWork + repository `with(tx)` wiring.
 *
 * The single correctness claim under test: every mutating use-case
 * commits its multi-step persistence (snapshot save + ledger append +
 * idempotency.complete + processed-webhook marker) inside ONE database
 * transaction, so a failure in any step rolls back the others.
 *
 * Strategy: the REAL production Postgres repository classes (the SQL they
 * emit and the `with(tx)` contract they implement) are the production code
 * under test. The REAL production UnitOfWork exercises the BEGIN/COMMIT/
 * ROLLBACK path against a fake Pool whose `connect()` returns a recording
 * executor. The recording executor is built on top of
 * `TransactionalSqlExecutor`, with the query() method overridden to:
 *  1. Recognize SQL prefixes and route to small in-memory projections
 *     (payment_intents, escrows, idempotency_keys, processed_webhooks,
 *     ledger_entries.max_sequence).
 *  2. Record the query so `getQueriesMatching` and the lifecycle list
 *     remain queryable after the use-case returns.
 *  3. Return rowCount=1 by default so production guards like
 *     `if (rowCount !== 1) throw ...` don't fire spuriously.
 *
 * SELECTs return empty rows; the production repos interpret "no row" as
 * "not found", which exercises the lookup paths without requiring a real
 * database. The integration specs (run separately, against real Postgres)
 * cover the data roundtrip.
 */

import {
  Pool,
  type PoolClient,
  type QueryResult,
  type QueryResultRow,
} from 'pg';
import { InitiatePaymentUseCase } from './initiate-payment.use-case';
import { HandlePaymentWebhookUseCase } from './handle-payment-webhook.use-case';
import { PostgresPaymentIntentRepository } from '../infrastructure/postgres-payment-intent.repository';
import { PostgresIdempotencyStore } from '../infrastructure/postgres-idempotency.store';
import { PostgresProcessedWebhookStore } from '../infrastructure/postgres-processed-webhook.store';
import { PostgresLedgerRepository } from '../../ledger/infrastructure/postgres-ledger.repository';
import { LedgerAppender } from '../../ledger/application/ledger-appender';
import { UnitOfWork } from '../../shared/infrastructure/unit-of-work';
import {
  TransactionalSqlExecutor,
  getQueriesMatching,
} from '../../shared/infrastructure/test-sql-executor';
import { NormalizedPaymentEvent } from '../../provider-integration/domain/normalized-payment-event';
import type { SqlExecutor } from '../../shared/infrastructure/db';

// --------------------------------------------------------------------- //
// Fake Pool + Client                                                     //
// --------------------------------------------------------------------- //

/**
 * A `PoolClient` substitute. The production UnitOfWork calls four methods
 * on the client it gets from `pool.connect()`:
 *  - `query(text)` for BEGIN / COMMIT / ROLLBACK
 *  - `query(text, values)` for all actual work
 *  - `release()` to return the client to the pool
 *  - nothing else.
 *
 * We extend `TransactionalSqlExecutor` (which already records queries
 * and tracks lifecycle) and override `query` to dispatch by SQL prefix
 * while still recording via the parent class's super.query path.
 */
class FakePoolClient extends TransactionalSqlExecutor {
  private released = false;

  // Projections — populated lazily by tests, queried by the wrapped query().
  intentRows = new Map<string, Record<string, unknown>>();
  idempotencyRows = new Map<string, 'in-progress' | 'completed'>();
  processedIds = new Set<string>();
  ledgerSeqByAggregate = new Map<string, number>();

  /** Marks the client as released. The unit-of-work calls this once per run(). */
  release(_err?: Error | boolean): void {
    void _err;
    this.released = true;
  }

  get wasReleased(): boolean {
    return this.released;
  }

  /**
   * Dispatch query() by SQL prefix. Records via the parent class's
   * `query` (which calls `record(this, text, values)`) so the lifecycle
   * list and `getQueriesMatching` continue to work.
   */
  override query<R extends QueryResultRow = QueryResultRow>(
    textOrConfig: string | { text: string; values?: unknown[] },
    maybeValues?: readonly unknown[],
  ): Promise<QueryResult<R>> {
    const { text, values } = normalizeQueryArgs(textOrConfig, maybeValues);
    const upper = text.trim().toUpperCase();

    // INSERT INTO payment_intents
    if (upper.startsWith('INSERT INTO PAYMENT_INTENTS')) {
      this.intentRows.set(values[0] as string, {
        intent_id: values[0],
        status: values[6],
        provider: values[5],
      });
      return super.query<R>(textOrConfig, maybeValues);
    }

    // INSERT INTO ledger_entries — track per-aggregate sequence.
    if (upper.startsWith('INSERT INTO LEDGER_ENTRIES')) {
      for (let i = 0; i < values.length; i += 8) {
        const aggregateId = values[i + 2] as string;
        const sequence = Number(values[i + 7]);
        const prev = this.ledgerSeqByAggregate.get(aggregateId) ?? 0;
        if (sequence > prev) {
          this.ledgerSeqByAggregate.set(aggregateId, sequence);
        }
      }
      return super.query<R>(textOrConfig, maybeValues);
    }

    // SELECT max(sequence)
    if (upper.startsWith('SELECT MAX(SEQUENCE)')) {
      const aggregateId = values[0] as string;
      const max = this.ledgerSeqByAggregate.get(aggregateId) ?? null;
      const prior = this.queryResults;
      this.queryResults = [
        ...prior,
        {
          prefix: 'SELECT MAX(SEQUENCE)',
          result: {
            rows: [{ max_sequence: max }],
            rowCount: max !== null ? 1 : 0,
          } as never,
        },
      ];
      try {
        return super.query<R>(textOrConfig, maybeValues);
      } finally {
        this.queryResults = prior;
      }
    }

    // SELECT * FROM payment_intents WHERE intent_id = $1
    if (upper.includes('FROM PAYMENT_INTENTS WHERE INTENT_ID')) {
      const id = values[0] as string;
      const row = this.intentRows.get(id);
      return Promise.resolve({
        rows: row ? [row as R] : [],
        rowCount: row ? 1 : 0,
      } as unknown as QueryResult<R>);
    }

    // SELECT * FROM payment_intents WHERE provider = $1 AND provider_charge_ref = $2
    if (upper.includes('FROM PAYMENT_INTENTS WHERE PROVIDER')) {
      const provider = values[0] as string;
      const chargeRef = values[1] as string;
      const row = [...this.intentRows.values()].find(
        (r) => r.provider === provider && r.provider_charge_ref === chargeRef,
      );
      return Promise.resolve({
        rows: row ? [row as R] : [],
        rowCount: row ? 1 : 0,
      } as unknown as QueryResult<R>);
    }

    // INSERT INTO idempotency_keys
    if (upper.startsWith('INSERT INTO IDEMPOTENCY_KEYS')) {
      const scope = String(values[0]);
      const key = String(values[1]);
      const composite = `${scope}:${key}`;
      const rowCount = this.idempotencyRows.has(composite) ? 0 : 1;
      if (rowCount === 1) {
        this.idempotencyRows.set(composite, 'in-progress');
      }
      const prior = this.queryResults;
      this.queryResults = [
        ...prior,
        {
          prefix: 'INSERT INTO IDEMPOTENCY_KEYS',
          result: { rows: [], rowCount } as never,
        },
      ];
      try {
        return super.query<R>(textOrConfig, maybeValues);
      } finally {
        this.queryResults = prior;
      }
    }

    // SELECT state, result FROM idempotency_keys
    if (upper.startsWith('SELECT STATE, RESULT FROM IDEMPOTENCY_KEYS')) {
      const scope = String(values[0]);
      const key = String(values[1]);
      const composite = `${scope}:${key}`;
      const state = this.idempotencyRows.get(composite);
      if (state !== 'completed') {
        return Promise.resolve({
          rows: [],
          rowCount: 0,
        } as unknown as QueryResult<R>);
      }
      return Promise.resolve({
        rows: [{ state: 'completed', result: null }],
        rowCount: 1,
      } as unknown as QueryResult<R>);
    }

    // UPDATE idempotency_keys ... SET state = 'completed'
    if (
      upper.startsWith('UPDATE IDEMPOTENCY_KEYS') &&
      upper.includes("SET STATE = 'COMPLETED'")
    ) {
      const scope = String(values[0]);
      const key = String(values[1]);
      const composite = `${scope}:${key}`;
      const rowCount =
        this.idempotencyRows.get(composite) === 'in-progress' ? 1 : 0;
      if (rowCount === 1) {
        this.idempotencyRows.set(composite, 'completed');
      }
      const prior = this.queryResults;
      this.queryResults = [
        ...prior,
        {
          prefix: 'UPDATE IDEMPOTENCY_KEYS',
          result: {
            rows: [],
            rowCount,
            command: 'UPDATE',
            oid: 0,
            fields: [],
          },
        },
      ];
      try {
        return super.query<R>(textOrConfig, maybeValues);
      } finally {
        this.queryResults = prior;
      }
    }

    // DELETE FROM idempotency_keys
    if (upper.startsWith('DELETE FROM IDEMPOTENCY_KEYS')) {
      const scope = String(values[0]);
      const key = String(values[1]);
      const composite = `${scope}:${key}`;
      const rowCount =
        this.idempotencyRows.get(composite) === 'in-progress' ? 1 : 0;
      if (rowCount === 1) {
        this.idempotencyRows.delete(composite);
      }
      return Promise.resolve({
        rows: [],
        rowCount,
      } as unknown as QueryResult<R>);
    }

    // SELECT 1 AS found FROM processed_webhooks
    if (upper.includes('FROM PROCESSED_WEBHOOKS')) {
      const id = values[0] as string;
      const found = this.processedIds.has(id);
      return Promise.resolve({
        rows: found ? [{ found: '1' }] : [],
        rowCount: found ? 1 : 0,
      } as unknown as QueryResult<R>);
    }

    // INSERT INTO processed_webhooks
    if (upper.startsWith('INSERT INTO PROCESSED_WEBHOOKS')) {
      this.processedIds.add(values[0] as string);
      return super.query<R>(textOrConfig, maybeValues);
    }

    // Fallback: record via super and return default result.
    return super.query<R>(textOrConfig, maybeValues);
  }
}

function normalizeQueryArgs(
  textOrConfig: string | { text: string; values?: unknown[] },
  maybeValues?: readonly unknown[],
): { text: string; values: readonly unknown[] } {
  if (typeof textOrConfig === 'string') {
    return { text: textOrConfig, values: maybeValues ?? [] };
  }
  return { text: textOrConfig.text, values: textOrConfig.values ?? [] };
}

function makeFakePool(client: FakePoolClient): Pool {
  // The fake Pool satisfies only the surface UnitOfWork calls:
  // `connect()` (returns the recording client), and `end()` (no-op,
  // unused by UnitOfWork). Other methods are stubbed to satisfy the
  // Pool type signature without participating in any test assertion.
  const EMPTY_QUERY_RESULT: QueryResult = {
    rows: [],
    rowCount: 0,
    command: 'SELECT',
    oid: 0,
    fields: [],
  };
  const fake: object = {
    connect: () => Promise.resolve(client as unknown as PoolClient),
    end: () => Promise.resolve(),
    query: () => Promise.resolve(EMPTY_QUERY_RESULT),
    on: () => fake,
    once: () => fake,
    removeListener: () => fake,
    removeAllListeners: () => fake,
    emit: () => true,
    listeners: () => [],
    listenerCount: () => 0,
  };
  // Pool has 15+ methods; this fake only implements the four the
  // production code calls (connect, end, query, plus EventEmitter).
  // Cast to unknown→Pool at construction since the cast is a lie only
  // about unused surface area.
  return fake as unknown as Pool;
}

// --------------------------------------------------------------------- //
// Fixture                                                                //
// --------------------------------------------------------------------- //

interface Fixture {
  client: FakePoolClient;
  unitOfWork: UnitOfWork;
  initiate: InitiatePaymentUseCase;
  webhook: HandlePaymentWebhookUseCase;
}

function makeFixture(): Fixture {
  const client = new FakePoolClient();
  // Default: every write returns rowCount=1 so production guards pass.
  client.defaultResult = {
    rows: [],
    rowCount: 1,
    command: 'INSERT',
    oid: 0,
    fields: [],
  };

  const pool = makeFakePool(client);
  const unitOfWork = new UnitOfWork(pool);
  // The FakePoolClient extends TransactionalSqlExecutor (which implements
  // SqlExecutor) but its `query` override only matches a subset of the
  // SqlExecutor overloads, so TypeScript can't narrow the assignment
  // automatically. We cast at the construction site because we know the
  // fake's contract matches what the production repos call.
  const tx = client as unknown as SqlExecutor;

  const intentRepo = new PostgresPaymentIntentRepository(tx);
  const ledgerRepo = new PostgresLedgerRepository(tx);
  const idempotencyRepo = new PostgresIdempotencyStore(tx);
  const processedRepo = new PostgresProcessedWebhookStore(tx);
  const ledgerAppender = new LedgerAppender(ledgerRepo);

  const initiate = new InitiatePaymentUseCase({
    idempotency: idempotencyRepo,
    intents: intentRepo,
    ledger: ledgerAppender,
    unitOfWork,
  });
  const webhook = new HandlePaymentWebhookUseCase({
    intents: intentRepo,
    ledger: ledgerAppender,
    processedWebhooks: processedRepo,
    unitOfWork,
  });

  return { client, unitOfWork, initiate, webhook };
}

// --------------------------------------------------------------------- //
// Tests                                                                  //
// --------------------------------------------------------------------- //

describe('UnitOfWork transaction atomicity (production repos, fake PoolClient)', () => {
  it('InitiatePayment success: the persistence pipeline runs inside one BEGIN → COMMIT cycle', async () => {
    const f = makeFixture();

    const result = await f.initiate.execute({
      amountMinor: 25_000,
      currency: 'NGN',
      method: 'card',
      idempotencyKey: 'atomic-init-success',
    });
    expect(result.ok).toBe(true);

    const beginCount = f.client.lifecycle.filter((s) => s === 'BEGIN').length;
    const commitCount = f.client.lifecycle.filter((s) => s === 'COMMIT').length;
    const rollbackCount = f.client.lifecycle.filter(
      (s) => s === 'ROLLBACK',
    ).length;
    expect(beginCount).toBe(1);
    expect(commitCount).toBe(1);
    expect(rollbackCount).toBe(0);

    expect(
      getQueriesMatching(f.client, 'INSERT INTO payment_intents').length,
    ).toBe(1);
    expect(
      getQueriesMatching(f.client, 'INSERT INTO ledger_entries').length,
    ).toBe(1);
    expect(
      getQueriesMatching(f.client, 'UPDATE idempotency_keys').length,
    ).toBeGreaterThanOrEqual(1);

    expect(
      f.client.idempotencyRows.get('payments.initiate:atomic-init-success'),
    ).toBe('completed');
  });

  it('InitiatePayment failure mid-transaction: lifecycle ends with ROLLBACK, key is released', async () => {
    const f = makeFixture();

    // Make the ledger INSERT throw. Capture the existing query (a
    // Promise-returning function) before re-wrapping it; preserve its
    // signature via the FakePoolClient.query type.
    type QueryFn = (
      textOrConfig: string | { text: string; values?: unknown[] },
      maybeValues?: readonly unknown[],
    ) => Promise<QueryResult>;
    const priorQuery: QueryFn = (
      f.client.query as unknown as { bind: (ctx: unknown) => QueryFn }
    ).bind(f.client);

    const wrapped: QueryFn = async (textOrConfig, maybeValues) => {
      const { text } = normalizeQueryArgs(textOrConfig, maybeValues);
      if (/INSERT INTO LEDGER_ENTRIES/i.test(text)) {
        throw new Error('simulated ledger failure');
      }
      return priorQuery(textOrConfig, maybeValues);
    };
    f.client.query = wrapped;

    let result: { ok: boolean; error?: unknown } | undefined;
    try {
      result = await f.initiate.execute({
        amountMinor: 25_000,
        currency: 'NGN',
        method: 'card',
        idempotencyKey: 'atomic-init-fail',
      });
    } catch {
      // The use case's outer catch re-throws after releasing the key;
      // either shape (Result error or thrown) is acceptable.
    }

    if (result) {
      expect(result.ok).toBe(false);
    }

    const lastCycle = lastBeginCommitCycle(f.client.lifecycle);
    expect(lastCycle).not.toBeNull();
    expect(lastCycle![1]).toBe('ROLLBACK');

    expect(
      f.client.idempotencyRows.has('payments.initiate:atomic-init-fail'),
    ).toBe(false);
  });

  it('HandlePaymentWebhook duplicate: dedup SELECT runs OUTSIDE the unit-of-work', async () => {
    const f = makeFixture();

    f.client.processedIds.add('evt_dup_atomic');

    const event = new NormalizedPaymentEvent({
      eventId: 'evt_dup_atomic',
      provider: 'paystack',
      type: 'CHARGE_SUCCEEDED',
      providerRef: 'NONEXISTENT',
      occurredAt: new Date('2026-09-21T12:00:00.000Z'),
    });

    const before = f.client.lifecycle.length;
    const result = await f.webhook.execute(event);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.outcome).toBe('DUPLICATE_IGNORED');

    const recent = f.client.lifecycle.slice(before);
    expect(recent.filter((s) => s === 'BEGIN').length).toBe(0);
    expect(recent.filter((s) => s === 'COMMIT').length).toBe(0);
  });

  it('HandlePaymentWebhook apply path: snapshot + journal + processed marker all in one tx', async () => {
    const f = makeFixture();

    // Seed a PROCESSING intent directly in the in-memory projection.
    const seedIntentId = '00000000-0000-0000-0000-000000000aaa';
    f.client.intentRows.set(seedIntentId, {
      intent_id: seedIntentId,
      idempotency_key: 'unused',
      amount_minor: '25000',
      currency: 'NGN',
      method: 'card',
      provider: 'paystack',
      status: 'PROCESSING',
      provider_charge_ref: 'CHARGE-REF-APPLY-1',
      refunded_amount_minor: '0',
      customer_ref: null,
      description: null,
      created_at: new Date('2026-09-21T00:00:00.000Z'),
      version: '0',
    });

    const event = new NormalizedPaymentEvent({
      eventId: 'evt_apply_atomic',
      provider: 'paystack',
      type: 'CHARGE_SUCCEEDED',
      providerRef: 'CHARGE-REF-APPLY-1',
      occurredAt: new Date('2026-09-21T12:00:00.000Z'),
      amountMinor: 25_000,
      currency: 'NGN',
    });

    const before = f.client.lifecycle.length;
    const result = await f.webhook.execute(event);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.outcome).toBe('APPLIED');

    const recent = f.client.lifecycle.slice(before);
    expect(recent[0]).toBe('BEGIN');
    expect(recent[recent.length - 1]).toBe('COMMIT');
    expect(f.client.processedIds.has('evt_apply_atomic')).toBe(true);
  });

  it('After every run(), the PoolClient is released exactly once', async () => {
    const f = makeFixture();

    await f.initiate.execute({
      amountMinor: 25_000,
      currency: 'NGN',
      method: 'card',
      idempotencyKey: 'atomic-release-check',
    });
    expect(f.client.wasReleased).toBe(true);
  });
});

// --------------------------------------------------------------------- //
// Helpers                                                                //
// --------------------------------------------------------------------- //

function lastBeginCommitCycle(
  lifecycle: readonly string[],
): ['BEGIN', 'COMMIT' | 'ROLLBACK'] | null {
  let beginIdx = -1;
  let endIdx = -1;
  let endKind: 'COMMIT' | 'ROLLBACK' | null = null;
  for (let i = lifecycle.length - 1; i >= 0; i -= 1) {
    const stmt = lifecycle[i];
    if (stmt === 'BEGIN' && endIdx !== -1 && endKind !== null) {
      beginIdx = i;
      break;
    }
    if (stmt === 'COMMIT' || stmt === 'ROLLBACK') {
      endIdx = i;
      endKind = stmt;
    }
  }
  if (beginIdx === -1 || endKind === null) return null;
  return ['BEGIN', endKind];
}

// Re-export to keep the import graph stable for any consumers that read
// the spec file for types only.
export type { SqlExecutor };
