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

import { UnitOfWorkModule } from '../shared/infrastructure/unit-of-work.module';
import { LedgerAppender } from './application/ledger-appender';
import { PostgresLedgerRepository } from './infrastructure/postgres-ledger.repository';

@Module({
  imports: [UnitOfWorkModule],
  providers: [LedgerAppender, PostgresLedgerRepository],
  exports: [LedgerAppender, PostgresLedgerRepository],
})
export class LedgerModule {}
