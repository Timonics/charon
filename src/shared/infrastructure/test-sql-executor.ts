import type { QueryResult, QueryResultRow } from 'pg';
import type { SqlExecutor } from './db';

/**
 * Test doubles for {@link SqlExecutor} that record every query in the order
 * it was issued. Used by use-case tests to prove the multi-step persistence
 * pipeline (intents.save → ledger.append → processed_webhooks.markProcessed)
 * routes through the SAME executor the unit-of-work passed in — i.e. the
 * whole batch is one transaction, not three autocommit statements.
 *
 * Three flavours:
 *  - {@link RecordingSqlExecutor}: returns a configurable default result
 *    and records every (text, params) pair for later assertion.
 *  - {@link FailingSqlExecutor}: extends RecordingSqlExecutor and throws on
 *    the Nth query, so tests prove rollback semantics.
 *  - {@link TransactionalSqlExecutor}: extends RecordingSqlExecutor and
 *    tracks BEGIN/COMMIT/ROLLBACK statements so tests can assert the
 *    unit-of-work lifecycle shape.
 *
 * All three implement the two `query` overloads the production Postgres
 * repos use (`query(text, values)` and `query({ text, values })`).
 * `SqlExecutor = Pick<Pool, 'query'>` exposes 5 overloads total; the three
 * unused ones (stream, queryConfig+array, callback) are not implemented
 * here — production code doesn't call them and the cast at construction
 * sites is safe.
 *
 * The `query` method is typed as `any` at the parameter boundary because
 * matching the full `Pool.query` overload set would require enumerating
 * five signatures; the runtime dispatch is clear from the body.
 */

/** A single recorded query call. */
export interface RecordedQuery {
  readonly text: string;
  readonly values: readonly unknown[];
  /** Index in the call sequence (0-based). */
  readonly index: number;
}

/** The shape node-postgres returns from a query. */
type TestQueryResult<R extends QueryResultRow = QueryResultRow> =
  QueryResult<R>;

/**
 * Default empty QueryResult with all required fields populated. Tests
 * that need richer rows push entries into `queryResults` instead.
 */
const EMPTY_RESULT: TestQueryResult = {
  command: '',
  oid: 0,
  fields: [],
  rows: [],
  rowCount: 0,
};

const recorders = new WeakMap<object, RecordedQuery[]>();

function record(
  executor: object,
  text: string,
  values: readonly unknown[],
): void {
  let list = recorders.get(executor);
  if (!list) {
    list = [];
    recorders.set(executor, list);
  }
  list.push({ text, values, index: list.length });
}

/**
 * Returns the queries executed against the given executor, in the order
 * they were issued. Throws if the executor isn't one of this module's fakes.
 */
export function getRecordedQueries(executor: object): readonly RecordedQuery[] {
  const list = recorders.get(executor);
  if (!list) {
    throw new Error(
      'getRecordedQueries called on an executor that is not a RecordingSqlExecutor or FailingSqlExecutor',
    );
  }
  return list;
}

/**
 * Returns only the queries whose SQL text starts with `prefix`. Useful for
 * "did the ledger INSERT happen" or "did the idempotency UPDATE happen"
 * style assertions without scanning the full list by hand.
 */
export function getQueriesMatching(
  executor: object,
  prefix: string,
): readonly RecordedQuery[] {
  return getRecordedQueries(executor).filter((q) =>
    q.text.trimStart().toUpperCase().startsWith(prefix.toUpperCase()),
  );
}

/**
 * A SqlExecutor-compatible recording fake. Records every call and returns
 * a configurable default result. Tests override `defaultResult` or push
 * entries into `queryResults` to synthesize specific SELECT responses.
 */
export class RecordingSqlExecutor implements SqlExecutor {
  /** Result returned by every query, unless overridden via `queryResults`. */
  public defaultResult: TestQueryResult = { ...EMPTY_RESULT };

  /**
   * Per-query overrides: the first matching entry (by SQL prefix, case-
   * insensitive) is returned; others fall through to `defaultResult`.
   */
  public readonly queryResults: Array<{
    prefix: string;
    result: TestQueryResult;
  }> = [];

  /** Optional callback fired after every query — for tests asserting side-effects. */
  public onQuery?: (text: string, values: readonly unknown[]) => void;

  /**
   * Implements the two text-based overloads of `Pool.query` used by the
   * production repos. Other Pool.query overloads are intentionally not
   * supported — production code never calls them. The cast at the
   * parameter boundary avoids the 5-overload `Pool['query']` type.
   */

  query<R extends QueryResultRow = QueryResultRow>(
    textOrConfig: any,

    maybeValues?: any,
  ): Promise<QueryResult<R>> {
    const text =
      typeof textOrConfig === 'string'
        ? textOrConfig
        : (textOrConfig as { text: string }).text;
    const values =
      typeof textOrConfig === 'string'
        ? ((maybeValues as readonly unknown[] | undefined) ?? [])
        : ((textOrConfig as { values?: unknown[] }).values ?? []);

    record(this, text, values);
    this.onQuery?.(text, values);

    const override = this.queryResults.find((o) =>
      text.trimStart().toUpperCase().startsWith(o.prefix.toUpperCase()),
    );
    return Promise.resolve(
      (override?.result ?? this.defaultResult) as QueryResult<R>,
    );
  }
}

/**
 * A RecordingSqlExecutor that throws on the Nth query (1-based: throwOn=1
 * throws on the first query, throwOn=2 on the second). Used to prove that
 * a use-case aborts cleanly when persistence fails mid-transaction.
 */
export class FailingSqlExecutor extends RecordingSqlExecutor {
  private callCount = 0;

  constructor(
    /** 1-based query index at which to throw. */
    public readonly throwOn: number,
    /** Error to throw. Defaults to a generic persistence error. */
    private readonly errorToThrow: Error = new Error('simulated DB failure'),
  ) {
    super();
  }

  override query<R extends QueryResultRow = QueryResultRow>(
    textOrConfig: string | { text: string; values?: unknown[] },
    maybeValues?: readonly unknown[],
  ): Promise<QueryResult<R>> {
    this.callCount += 1;
    if (this.callCount === this.throwOn) {
      const text =
        typeof textOrConfig === 'string' ? textOrConfig : textOrConfig.text;
      record(
        this,
        text,
        typeof textOrConfig === 'string'
          ? (maybeValues ?? [])
          : (textOrConfig.values ?? []),
      );
      return Promise.reject(this.errorToThrow);
    }
    return super.query<R>(textOrConfig, maybeValues);
  }
}

/**
 * A RecordingSqlExecutor that simulates a real transaction client. Tracks
 * BEGIN/COMMIT/ROLLBACK statements so tests can assert that the
 * UnitOfWork called all three in the right shape (BEGIN first, then
 * COMMIT or ROLLBACK depending on the work's outcome).
 */
export class TransactionalSqlExecutor extends RecordingSqlExecutor {
  /** The statements the test expected to see, in order, including BEGIN/COMMIT/ROLLBACK. */
  public readonly lifecycle: string[] = [];

  override query<R extends QueryResultRow = QueryResultRow>(
    textOrConfig: string | { text: string; values?: unknown[] },
    maybeValues?: readonly unknown[],
  ): Promise<QueryResult<R>> {
    const text = (
      typeof textOrConfig === 'string' ? textOrConfig : textOrConfig.text
    ).trim();
    const upper = text.toUpperCase();
    if (upper === 'BEGIN' || upper === 'COMMIT' || upper === 'ROLLBACK') {
      this.lifecycle.push(upper);
    }
    return super.query<R>(textOrConfig, maybeValues);
  }

  /** Did this executor see BEGIN followed by COMMIT (success)? */
  get committed(): boolean {
    return (
      this.lifecycle[0] === 'BEGIN' &&
      this.lifecycle[this.lifecycle.length - 1] === 'COMMIT'
    );
  }

  /** Did this executor see BEGIN followed by ROLLBACK? */
  get rolledBack(): boolean {
    return (
      this.lifecycle[0] === 'BEGIN' &&
      this.lifecycle[this.lifecycle.length - 1] === 'ROLLBACK'
    );
  }
}
