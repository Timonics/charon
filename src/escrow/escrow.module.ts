/**
 * Escrow bounded context module.
 *
 * Provides the five escrow use cases + the Postgres repository,
 * bound to the shared UnitOfWork. Exports the use cases so the
 * HTTP controller (in InterfaceModule) can inject them.
 *
 * Note: `confirm-escrow-hold` and `release-escrow` are listed
 * but not exported — they are internal helpers called by the
 * other use cases, not directly exposed via HTTP in V1.
 */
import { Module } from '@nestjs/common';

import { LedgerModule } from '../ledger/ledger.module';
import { UnitOfWorkModule } from '../shared/infrastructure/unit-of-work.module';
import { CancelEscrowUseCase } from './application/cancel-escrow.use-case';
import { ConfirmEscrowHoldUseCase } from './application/confirm-escrow-hold.use-case';
import { DisputeEscrowUseCase } from './application/dispute-escrow.use-case';
import { PlaceEscrowHoldUseCase } from './application/place-escrow-hold.use-case';
import { RefundEscrowUseCase } from './application/refund-escrow.use-case';
import { ReleaseEscrowUseCase } from './application/release-escrow.use-case';
import { ResolveDisputeUseCase } from './application/resolve-dispute.use-case';
import { PostgresEscrowRepository } from './infrastructure/postgres-escrow.repository';

@Module({
  imports: [LedgerModule, UnitOfWorkModule],
  providers: [
    PostgresEscrowRepository,
    PlaceEscrowHoldUseCase,
    ConfirmEscrowHoldUseCase,
    ReleaseEscrowUseCase,
    RefundEscrowUseCase,
    DisputeEscrowUseCase,
    ResolveDisputeUseCase,
    CancelEscrowUseCase,
  ],
  exports: [
    PlaceEscrowHoldUseCase,
    RefundEscrowUseCase,
    DisputeEscrowUseCase,
    ResolveDisputeUseCase,
    CancelEscrowUseCase,
    PostgresEscrowRepository,
  ],
})
export class EscrowModule {}
