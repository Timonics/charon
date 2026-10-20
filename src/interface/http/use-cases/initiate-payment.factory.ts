/**
 * Per-request factory for `InitiatePaymentUseCase`.
 *
 * The use case takes its `principal` via the `deps` bag, not
 * as a method argument — that keeps the application layer's
 * authorization check inside the use case (where the
 * tenant-ownership assertion lives). But it means a fresh
 * use case instance is required per request, because
 * `principal` differs per request.
 *
 * This factory injects the *static* parts of `deps` once
 * (repositories, ledger, idempotency store, UnitOfWork) and
 * exposes `for(principal, gateways)` to bind the per-request
 * parts. The controller calls `factory.for(...)` per request.
 *
 * Why a factory and not a regular provider? NestJS's DI graph
 * is built once at boot. A provider that takes per-request
 * state at construction time can only see the first request's
 * state. The factory pattern is the canonical fix: inject
 * static deps at boot, return a per-request closure that
 * carries the per-request data.
 */
import { Inject, Injectable } from '@nestjs/common';

import { InitiatePaymentUseCase } from '../../../payments/application/initiate-payment.use-case';
import { PostgresIdempotencyStore } from '../../../payments/infrastructure/postgres-idempotency.store';
import { PostgresPaymentIntentRepository } from '../../../payments/infrastructure/postgres-payment-intent.repository';
import type { PaymentGatewayPort } from '../../../provider-integration/application/ports/payment-gateway.port';
import { LedgerAppender } from '../../../ledger/application/ledger-appender';
import { UnitOfWork } from '../../../shared/infrastructure/unit-of-work';
import { ProviderName } from '../../../shared/kernel/provider-name';
import type { Principal } from '../../../shared/kernel/tenant';
import { PAYMENT_GATEWAYS } from '../../../payments/payment.constants';

@Injectable()
export class InitiatePaymentFactory {
  constructor(
    private readonly intents: PostgresPaymentIntentRepository,
    private readonly idempotency: PostgresIdempotencyStore,
    private readonly ledger: LedgerAppender,
    private readonly unitOfWork: UnitOfWork,
    @Inject(PAYMENT_GATEWAYS)
    private readonly gateways: ReadonlyMap<string, PaymentGatewayPort>,
  ) {}

  /**
   * Build a use case instance for the current request. The
   * `principal` is per-request (different callers can have
   * different tenants), so it must be supplied here. The
   * gateways are read from the same `PAYMENT_GATEWAYS` token
   * the constructor wired; if a future composition-root change
   * needs per-request gateway selection (e.g. tenant-scoped
   * provider enablement), the override happens here.
   */
  for(principal: Principal): InitiatePaymentUseCase {
    return new InitiatePaymentUseCase({
      principal,
      intents: this.intents,
      idempotency: this.idempotency,
      ledger: this.ledger,
      unitOfWork: this.unitOfWork,
      gateways: this.gateways as ReadonlyMap<ProviderName, PaymentGatewayPort>,
    });
  }
}
