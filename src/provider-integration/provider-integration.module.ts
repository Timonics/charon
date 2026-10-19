/**
 * Provider-integration bounded context module.
 *
 * This module owns the **outbound** half of the provider integration
 * (the gateway adapters) plus the **inbound** half (the webhook
 * adapters, the webhook inbox, the signature verification, the
 * event normalization).
 *
 * Composition root (in this module):
 *   - Reads `CHRON_PAYMENT_ENABLED_PROVIDERS` (a comma-separated
 *     list of `paystack|flutterwave|stripe`).
 *   - For each enabled provider, instantiates the matching
 *     gateway adapter with the secret key from
 *     `CHRON_<PROVIDER>_SECRET_KEY`.
 *   - Builds the `Map<ProviderName, PaymentGatewayPort>` and
 *     publishes it under the `PAYMENT_GATEWAYS` token.
 *
 * Today only Paystack is implemented. Flutterwave and Stripe
 * land as separate PRs that each add their adapter + their
 * entry to the gateway-map factory below.
 *
 * V1 webhooks: this module provides the `ProviderWebhookPort`
 * implementations (Paystack today, plus the others as they
 * land). The HTTP webhook controller is in InterfaceModule
 * and delegates event parsing + signature verification to
 * these adapters.
 */
import { Module } from '@nestjs/common';

import {
  FetchHttpClient,
  type HttpClient,
} from '../shared/infrastructure/http-client';
import { UnitOfWorkModule } from '../shared/infrastructure/unit-of-work.module';
import { MissingGatewayAdapterError } from './application/errors';
import type { PaymentGatewayPort } from './application/ports/payment-gateway.port';
import { PaystackGatewayAdapter } from './infrastructure/paystack/paystack-gateway.adapter';
import { PaystackWebhookAdapter } from './infrastructure/paystack/paystack-webhook.adapter';
import { PostgresWebhookInboxStore } from './infrastructure/postgres-webhook-inbox.store';
import { PAYMENT_GATEWAYS } from '../payments/payment.constants';

@Module({
  imports: [UnitOfWorkModule],
  providers: [
    FetchHttpClient,
    PostgresWebhookInboxStore,
    PaystackWebhookAdapter,
    {
      // The payment gateway map. Built from the
      // `CHRON_PAYMENT_ENABLED_PROVIDERS` env var (default
      // 'paystack'). Each provider needs its corresponding
      // `CHRON_<PROVIDER>_SECRET_KEY` env var; a missing key
      // throws at boot (fail-loud, never fail-silent).
      provide: PAYMENT_GATEWAYS,
      useFactory: (http: HttpClient): Map<string, PaymentGatewayPort> => {
        const enabled = (
          process.env.CHRON_PAYMENT_ENABLED_PROVIDERS ?? 'paystack'
        )
          .split(',')
          .map((s) => s.trim().toLowerCase())
          .filter((s) => s.length > 0);
        const map = new Map<string, PaymentGatewayPort>();
        for (const name of enabled) {
          switch (name) {
            case 'paystack': {
              const key = process.env.CHRON_PAYSTACK_SECRET_KEY;
              if (!key) {
                throw new MissingGatewayAdapterError(
                  'paystack: CHRON_PAYSTACK_SECRET_KEY is not set',
                );
              }
              map.set('paystack', new PaystackGatewayAdapter(http, key));
              break;
            }
            // case 'flutterwave': // lands in PR-NN3
            // case 'stripe':      // lands in PR-NN4
            default:
              // Unknown provider name in the env var. Skip
              // with a warning rather than crashing the
              // boot — operators may want to disable a
              // provider by removing it from the env, and
              // a typo in a future PR shouldn't break
              // production.

              console.warn(
                `[charon] unknown provider in CHRON_PAYMENT_ENABLED_PROVIDERS: ${name} (skipped)`,
              );
          }
        }
        if (map.size === 0) {
          throw new Error(
            '[charon] No payment gateway adapters enabled. Set CHRON_PAYMENT_ENABLED_PROVIDERS to at least one of: paystack.',
          );
        }
        return map;
      },
      inject: [FetchHttpClient],
    },
  ],
  exports: [
    PostgresWebhookInboxStore,
    PaystackWebhookAdapter,
    PAYMENT_GATEWAYS,
  ],
})
export class ProviderIntegrationModule {}
