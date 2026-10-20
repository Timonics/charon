/**
 * Ledger bounded context module.
 *
 * The ledger is intentionally tiny: it owns the append-only journal
 * of every monetary event in the system. This module exposes the
 * `LedgerAppender` (the write side) and the `PostgresLedgerRepository`
 * (the read side, for projections).
 *
 * The ledger never depends on any other context. Other contexts
 * depend on the ledger (PaymentsModule, EscrowModule both import
 * LedgerModule).
 */
import { Module } from '@nestjs/common';

import { type SqlExecutor } from '../shared/infrastructure/db';
import { UnitOfWorkModule } from '../shared/infrastructure/unit-of-work.module';
import { LedgerAppender } from './application/ledger-appender';
import { PostgresLedgerRepository } from './infrastructure/postgres-ledger.repository';

@Module({
  imports: [UnitOfWorkModule],
  providers: [
    LedgerAppender,
    {
      provide: PostgresLedgerRepository,
      useFactory: (db: SqlExecutor) => new PostgresLedgerRepository(db),
      inject: ['SQL_EXECUTOR'],
    },
  ],
  exports: [LedgerAppender, PostgresLedgerRepository],
})
export class LedgerModule {}
