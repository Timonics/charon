/**
 * Auth module.
 *
 * V1 (pre-PR-NN2): the NoAuthGuard reads a `X-Dev-Principal`
 * header in non-production environments. It refuses every
 * request in production so a misconfigured prod environment
 * fails closed.
 *
 * PR-NN2: this module gets a `CerberusAuthGuard` that verifies
 * the inbound JWT against Cerberus's JWKS, then constructs
 * the typed Principal. The NoAuthGuard is deleted.
 */
import { Module } from '@nestjs/common';

import { NoAuthGuard } from './no-auth.guard';

@Module({
  providers: [NoAuthGuard],
  exports: [NoAuthGuard],
})
export class AuthModule {}
