/**
 * Interface module.
 *
 * Owns the HTTP-facing surface: controllers, DTOs, the
 * raw-body middleware. Imports the four bounded contexts
 * (for the use cases the controllers call) and the auth
 * module (for the NoAuthGuard).
 *
 * Stage 1 of the P0-1 PR (this file) ships just the module
 * shell + the raw-body middleware. Stage 2 adds the actual
 * controllers (`POST /payments`, `POST /webhooks/:provider`,
 * `GET /healthz`).
 */
import { MiddlewareConsumer, Module, NestModule } from '@nestjs/common';

import { AuthModule } from '../auth/auth.module';
import { EscrowModule } from '../escrow/escrow.module';
import { PaymentsModule } from '../payments/payments.module';
import { ProviderIntegrationModule } from '../provider-integration/provider-integration.module';
import { RawBodyMiddleware } from './http/middleware/raw-body.middleware';

@Module({
  imports: [
    AuthModule,
    PaymentsModule,
    EscrowModule,
    ProviderIntegrationModule,
  ],
})
export class InterfaceModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    // The raw-body middleware runs for every request. Webhook
    // controllers read req.rawBody for HMAC verification; other
    // controllers ignore it. See raw-body.middleware.ts for the
    // rationale on running this globally vs per-route.
    consumer.apply(RawBodyMiddleware).forRoutes('*');
  }
}
