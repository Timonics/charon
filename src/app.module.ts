/**
 * Charon — root application module.
 *
 * Wires the four bounded contexts (payments, escrow, ledger,
 * provider-integration) plus the auth boundary. Until PR-NN2
 * (Cerberus auth) lands, the auth boundary is a `NoAuthGuard` that
 * reads a `X-Dev-Principal` header in non-production environments.
 * PR-NN2 replaces this guard with the real Cerberus JWT
 * verification.
 *
 * Composition root responsibilities (all in this module):
 *
 *   - Build the `UnitOfWork` once (process-wide).
 *   - Build the per-context repositories with the UnitOfWork as
 *     their persistence layer.
 *   - Build the per-context use cases with the repositories,
 *     the ledger, the idempotency store, and the gateway map.
 *   - Build the `gateways: Map<ProviderName, PaymentGatewayPort>`
 *     from `CHRON_PAYMENT_ENABLED_PROVIDERS`. Paystack is the
 *     only adapter today; Flutterwave + Stripe land as separate
 *     PRs that each add their adapter + their entry to the env
 *     config.
 *   - Provide a `DEV_PRINCIPAL_HEADER` token so the dev
 *     e2e specs can exercise the auth boundary without minting
 *     real JWTs.
 */
import { Module } from '@nestjs/common';

import { PaymentsModule } from './payments/payments.module';
import { EscrowModule } from './escrow/escrow.module';
import { LedgerModule } from './ledger/ledger.module';
import { ProviderIntegrationModule } from './provider-integration/provider-integration.module';
import { AuthModule } from './auth/auth.module';
import { InterfaceModule } from './interface/interface.module';

@Module({
  imports: [
    // The four bounded contexts.
    PaymentsModule,
    EscrowModule,
    LedgerModule,
    ProviderIntegrationModule,
    // Auth (NoAuthGuard today; CerberusAuthGuard in PR-NN2).
    AuthModule,
    // HTTP controllers + DTOs + raw-body middleware.
    InterfaceModule,
  ],
})
export class AppModule {}
