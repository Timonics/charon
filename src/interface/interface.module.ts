/**
 * Interface module.
 *
 * Owns the HTTP-facing surface: controllers, DTOs, the
 * raw-body middleware, and per-request use case factories.
 * Imports the four bounded contexts (for the use cases the
 * controllers call) and the auth module (for the NoAuthGuard).
 *
 * Stage 2 of the P0-1 PR adds:
 *   - PaymentsController (POST /payments, GET /payments/:id)
 *   - WebhooksController (POST /webhooks/paystack)
 *   - HealthController (GET /healthz)
 *   - InitiatePaymentFactory (per-request use case construction
 *     because the principal is request-scoped)
 */
import { Module } from '@nestjs/common';

import { AuthModule } from '../auth/auth.module';
import { EscrowModule } from '../escrow/escrow.module';
import { LedgerModule } from '../ledger/ledger.module';
import { PaymentsModule } from '../payments/payments.module';
import { ProviderIntegrationModule } from '../provider-integration/provider-integration.module';
import { UnitOfWorkModule } from '../shared/infrastructure/unit-of-work.module';
import { HealthController } from './http/controllers/health.controller';
import { PaymentsController } from './http/controllers/payments.controller';
import { WebhooksController } from './http/controllers/webhooks.controller';
import { InitiatePaymentFactory } from './http/use-cases/initiate-payment.factory';

@Module({
  imports: [
    AuthModule,
    PaymentsModule,
    EscrowModule,
    LedgerModule,
    ProviderIntegrationModule,
    UnitOfWorkModule,
  ],
  controllers: [PaymentsController, WebhooksController, HealthController],
  providers: [InitiatePaymentFactory],
})
export class InterfaceModule {}
