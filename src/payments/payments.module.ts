/**
 * Payments bounded context module.
 *
 * Provides:
 *   - The three payment use cases (Initiate, HandleWebhook, Refund).
 *   - The Postgres repository and idempotency store, bound to the
 *     shared `UnitOfWork`.
 *
 * Does NOT provide:
 *   - The gateway adapters themselves — those live in
 *     ProviderIntegrationModule, which also publishes the
 *     `PAYMENT_GATEWAYS` map under the matching token. This
 *     module reads gateways through that token; it never
 *     builds them. The cross-module wiring keeps the two
 *     contexts decoupled and avoids a circular import
 *     (ProviderIntegrationModule needs to know about the
 *     payments use cases for the gateway map, but the
 *     payments use cases need the gateway map — one of the
 *     two has to provide, and the integration module is the
 *     cleaner choice because it owns the providers).
 *   - The auth boundary — that's the AuthModule.
 */
import { Module } from '@nestjs/common';

import { LedgerModule } from '../ledger/ledger.module';
import { UnitOfWorkModule } from '../shared/infrastructure/unit-of-work.module';
import { InitiatePaymentUseCase } from './application/initiate-payment.use-case';
import { HandlePaymentWebhookUseCase } from './application/handle-payment-webhook.use-case';
import { RefundPaymentUseCase } from './application/refund-payment.use-case';
import { PostgresIdempotencyStore } from './infrastructure/postgres-idempotency.store';
import { PostgresPaymentIntentRepository } from './infrastructure/postgres-payment-intent.repository';
import { PostgresProcessedWebhookStore } from './infrastructure/postgres-processed-webhook.store';
import { PostgresSettledPaymentQuery } from './infrastructure/postgres-settled-payment.query';

@Module({
  imports: [LedgerModule, UnitOfWorkModule],
  providers: [
    PostgresPaymentIntentRepository,
    PostgresIdempotencyStore,
    PostgresProcessedWebhookStore,
    PostgresSettledPaymentQuery,
    InitiatePaymentUseCase,
    HandlePaymentWebhookUseCase,
    RefundPaymentUseCase,
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
