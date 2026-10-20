/**
 * Express `Request` augmented with the authenticated principal.
 *
 * The `NoAuthGuard` (V1) sets `req.principal` after parsing the
 * `X-Dev-Principal` header. PR-NN2's `CerberusAuthGuard` does
 * the same after verifying the inbound JWT. Either way, the
 * controller can rely on `req.principal` being set — and
 * should treat its absence as a guard-misconfiguration bug.
 */
import type { Request } from 'express';
import type { Principal } from '../../../shared/kernel/tenant';

export type RequestWithPrincipal = Request & {
  principal?: Principal;
};
