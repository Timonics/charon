/**
 * UnitOfWork provider module.
 *
 * Exposes the single process-wide `UnitOfWork` (which itself
 * delegates to the lazy `getPool()` from `db.ts`) so the
 * repository modules can `imports: [UnitOfWorkModule]` instead
 * of constructing their own.
 *
 * Also exposes a concrete `PostgresPool` that wraps the pg
 * Pool and implements the structural `SqlExecutor` interface.
 * The repositories depend on `SqlExecutor` (a Pick<Pool>), and
 * NestJS's DI graph can't resolve a structural interface from
 * a token — it needs an actual class. The wrapper bridges
 * the gap: the providers list `SqlExecutor` and the module
 * binds the same token to the PostgresPool instance.
 *
 * Why a module for two providers: NestJS's DI graph needs
 * every cross-cutting dependency to be declared as a module
 * import. Wrapping both the UnitOfWork and the pool in one
 * tiny module is the conventional way.
 */
import { Module } from '@nestjs/common';
import type { SqlExecutor } from './db';
import { getPool } from './db';

import { UnitOfWork } from './unit-of-work';

/**
 * Concrete wrapper around the process-wide pg `Pool`. Implements
 * the structural `SqlExecutor` so the repositories can be
 * injected via DI without writing per-repo factory providers.
 *
 * The `query` method delegates to the lazy `getPool()` so the
 * Pool is opened on first use (not on module import).
 */
class PostgresPool implements SqlExecutor {
  query: SqlExecutor['query'] = ((text, params, callback) =>
    getPool().query(text, params, callback)) as SqlExecutor['query'];
}

@Module({
  providers: [
    {
      provide: PostgresPool,
      useFactory: (): PostgresPool => new PostgresPool(),
    },
    {
      // The SqlExecutor token (the structural interface) is
      // bound to the same PostgresPool instance. Repositories
      // that depend on `SqlExecutor` get this pool.
      provide: 'SQL_EXECUTOR',
      useExisting: PostgresPool,
    },
    UnitOfWork,
  ],
  exports: [PostgresPool, 'SQL_EXECUTOR', UnitOfWork],
})
export class UnitOfWorkModule {}
