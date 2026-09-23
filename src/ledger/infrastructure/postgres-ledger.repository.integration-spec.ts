import { execSync } from 'node:child_process';

import { Pool } from 'pg';

import { LedgerEntry } from '../domain/ledger-entry';
import { SequenceGapError } from '../domain/errors';
import { PostgresLedgerRepository } from './postgres-ledger.repository';

/**
 * INTEGRATION TEST — runs against a real Postgres (docker compose up -d
 * postgres). This is deliberately NOT a unit test: the behavior under test
 * IS the database's (constraint enforcement, atomic multi-row insert), and
 * mocking pg would test nothing. Run via `npm run test:integration` with
 * DATABASE_URL set (see .env.example).
 *
 * Each run is self-sufficient: migrations are applied idempotently in
 * beforeAll, and the table is truncated per test. Never point this at a
 * database you care about.
 */
const databaseUrl =
  process.env.DATABASE_URL ??
  'postgres://postgres:postgres@localhost:5432/charon';

const AGGREGATE_A = '3fa85f64-5717-4562-b3fc-2c963f66afa6';
const AGGREGATE_B = '4fb96f75-6828-4673-a4cd-3da74f77bfb7';

function entry(
  aggregateId: string,
  sequence: number,
  eventType = 'PaymentSucceeded',
) {
  return LedgerEntry.record({
    aggregateType: 'PaymentIntent',
    aggregateId,
    eventType,
    payload: { amount: 1_000, currency: 'NGN' },
    occurredAt: new Date('2026-09-21T12:00:00.000Z'),
    sequence,
  });
}

describe('PostgresLedgerRepository (integration)', () => {
  let pool: Pool;
  let repository: PostgresLedgerRepository;

  beforeAll(() => {
    pool = new Pool({ connectionString: databaseUrl });
    // Apply migrations through the same CLI developers use. Idempotent:
    // already-applied migrations are skipped, so repeat and parallel runs
    // are both safe. DATABASE_URL is inherited from the environment.
    execSync('node-pg-migrate up', {
      stdio: 'pipe',
      env: { ...process.env, DATABASE_URL: databaseUrl },
    });
    repository = new PostgresLedgerRepository(pool);
  });

  beforeEach(async () => {
    await pool.query('TRUNCATE ledger_entries');
  });

  afterAll(async () => {
    await pool.end();
  });

  it('appends entries and reads back the last sequence per aggregate', async () => {
    expect(await repository.lastSequence(AGGREGATE_A)).toBeUndefined();

    await repository.append([entry(AGGREGATE_A, 1), entry(AGGREGATE_A, 2)]);
    await repository.append([entry(AGGREGATE_B, 1)]);

    expect(await repository.lastSequence(AGGREGATE_A)).toBe(2);
    expect(await repository.lastSequence(AGGREGATE_B)).toBe(1);

    // And the rows actually landed with their payload intact.
    const { rows } = await pool.query<{
      event_type: string;
      sequence: number;
      payload: unknown;
    }>(
      'SELECT event_type, sequence, payload FROM ledger_entries WHERE aggregate_id = $1 ORDER BY sequence',
      [AGGREGATE_A],
    );
    expect(rows).toHaveLength(2);
    expect(rows[0].payload).toEqual({ amount: 1_000, currency: 'NGN' });
  });

  it('is a no-op for empty batches', async () => {
    await repository.append([]);
    const { rows } = await pool.query<{ n: number }>(
      'SELECT count(*)::int AS n FROM ledger_entries',
    );
    expect(rows[0].n).toBe(0);
  });

  it('rejects a sequence gap with SequenceGapError, writing nothing', async () => {
    await repository.append([entry(AGGREGATE_A, 1)]);

    // Attempt to append sequence 3 directly — a lost event in between.
    await expect(
      repository.append([entry(AGGREGATE_A, 3)]),
    ).rejects.toBeInstanceOf(SequenceGapError);

    // The failed batch must not have partially landed.
    expect(await repository.lastSequence(AGGREGATE_A)).toBe(1);
  });

  it('rejects a duplicate sequence (stale lastSequence read / concurrent writer)', async () => {
    await repository.append([entry(AGGREGATE_A, 1), entry(AGGREGATE_A, 2)]);

    // Simulates a second writer whose lastSequence read also returned 1.
    await expect(
      repository.append([entry(AGGREGATE_A, 2)]),
    ).rejects.toBeInstanceOf(SequenceGapError);
    expect(await repository.lastSequence(AGGREGATE_A)).toBe(2);
  });
});
