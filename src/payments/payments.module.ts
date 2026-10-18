/**
 * Payments bounded context module.
 *
 * Provides:
 *   - The three payment use cases (Initiate, HandleWebhook, Refund).
 *   - The Postgres repository and idempotency store, bound to the
 *     shared `UnitOfWork`.
 *   - The `PaymentGatewayMap` (a typed token whose value is the
 *     `Map<ProviderName, PaymentGatewayPort>` from the composition
 *     root).
 *
 * Does NOT provide:
 *   - The gateway adapters themselves — those live in
 *     ProviderIntegrationModule so the gateway map can be built
 *     without circular dependencies.
 *   - The auth boundary — that's the AuthModule.
 */
import { Module } from '@nestjs/common';

import { LedgerModule } from '../ledger/ledger.module';
import { ProviderIntegrationModule } from '../provider-integration/provider-integration.module';
import { UnitOfWorkModule } from '../shared/infrastructure/unit-of-work.module';
import { InitiatePaymentUseCase } from './application/initiate-payment.use-case';
import { HandlePaymentWebhookUseCase } from './application/handle-payment-webhook.use-case';
import { RefundPaymentUseCase } from './application/refund-payment.use-case';
import { PostgresIdempotencyStore } from './infrastructure/postgres-idempotency.store';
import { PostgresPaymentIntentRepository } from './infrastructure/postgres-payment-intent.repository';
import { PostgresProcessedWebhookStore } from './infrastructure/postgres-processed-webhook.store';
import { PostgresSettledPaymentQuery } from './infrastructure/postgres-settled-payment.query';
import { PAYMENT_GATEWAYS } from './payment.constants';

@Module({
  imports: [LedgerModule, ProviderIntegrationModule, UnitOfWorkModule],
  providers: [
    PostgresPaymentIntentRepository,
    PostgresIdempotencyStore,
    PostgresProcessedWebhookStore,
    PostgresSettledPaymentQuery,
    InitiatePaymentUseCase,
    HandlePaymentWebhookUseCase,
    RefundPaymentUseCase,
    {
      // The gateway map is built in the composition root
      // (AppModule bootstraps this module's providers; the actual
      // map value is supplied by ProviderIntegrationModule's
      // composition root contribution via the PAYMENT_GATEWAYS
      // token). The payments module doesn't need to know which
      // providers are enabled — it just looks them up.
      provide: PAYMENT_GATEWAYS,
      useFactory: (
        // Lazy-resolve the gateway map from ProviderIntegrationModule.
        // We do this through a string token to avoid a circular
        // import between PaymentsModule and ProviderIntegrationModule.
        // ProviderIntegrationModule exports the map under
        // `PAYMENT_GATEWAY_MAP` (see provider-integration.module.ts).
      ) => {
        // The actual map is injected at the controller level via
        // the AppModule's composition root. This factory is a
        // placeholder that returns an empty map; the
        // composition-root override in AppModule replaces it.
        return new Map();
      },
    },
  ],
  exports: [
    InitiatePaymentUseCase,
    HandlePaymentWebhookUseCase,
    RefundPaymentUseCase,
    PostgresPaymentIntentRepository,
    PostgresSettledPaymentQuery,
  ],
})
export class PaymentsModule {}
