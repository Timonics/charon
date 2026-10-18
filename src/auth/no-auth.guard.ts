/**
 * Auth module — V1 NoAuthGuard.
 *
 * Until PR-NN2 (Cerberus auth) lands, the service has no real
 * authentication. The NoAuthGuard reads a `X-Dev-Principal`
 * header in non-production environments and builds a Principal
 * from it. In production the guard refuses every request
 * (returns 401) so a misconfigured prod environment fails
 * closed rather than silently accepting unauthenticated traffic.
 *
 * The header format is a compact JSON object:
 *
 *   {
 *     "kind": "app" | "user",
 *     "appId"?: "<uuid>",
 *     "userId"?: "<uuid>",
 *     "tenantId": "<uuid> | null",
 *     "role"?: "OWNER" | "ADMIN" | "MEMBER" | null,
 *     "scopes": ["payments:write", ...],
 *     "expiresAt": "<iso-8601>"
 *   }
 *
 * The `kind` discriminator determines the rest of the shape.
 * Bad input → 401.
 *
 * In non-prod environments the guard also accepts a `*` header
 * value that uses a hard-coded `TEST_TENANT` for the dev e2e
 * specs. The `*` shortcut is rejected when NODE_ENV=production.
 */
import {
  CanActivate,
  ExecutionContext,
  Injectable,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import type { Request } from 'express';

import { rehydrateTenantId, type Principal } from '../shared/kernel/tenant';
import { DEV_PRINCIPAL_HEADER } from '../payments/payment.constants';

@Injectable()
export class NoAuthGuard implements CanActivate {
  private readonly logger = new Logger(NoAuthGuard.name);

  canActivate(context: ExecutionContext): boolean {
    const isProduction = process.env.NODE_ENV === 'production';
    const req = context.switchToHttp().getRequest<Request>();
    const header = req.header(DEV_PRINCIPAL_HEADER);

    if (isProduction) {
      // Fail closed in production. PR-NN2 replaces this
      // entire guard with CerberusAuthGuard.
      throw new UnauthorizedException(
        'X-Dev-Principal header is not accepted in production. ' +
          'Auth boundary is currently a NoAuthGuard — wire the real one before deploying.',
      );
    }

    if (!header) {
      this.logger.warn(
        `${req.method} ${req.path} reached the dev auth guard without a ` +
          `X-Dev-Principal header. Returning 401.`,
      );
      throw new UnauthorizedException(
        `Missing ${DEV_PRINCIPAL_HEADER} header. ` +
          `This dev-only auth guard requires the principal to be supplied per request.`,
      );
    }

    const parsed = this.parsePrincipal(header);
    if (!parsed) {
      throw new UnauthorizedException(
        `Invalid ${DEV_PRINCIPAL_HEADER} value. Expected JSON.`,
      );
    }

    // Stash the principal on the request so the controller can
    // pick it up without re-parsing.
    (req as Request & { principal?: Principal }).principal = parsed;
    return true;
  }

  private parsePrincipal(raw: string): Principal | null {
    let body: unknown;
    try {
      body = JSON.parse(raw);
    } catch {
      return null;
    }
    if (typeof body !== 'object' || body === null) return null;
    const obj = body as Record<string, unknown>;

    if (obj.kind === 'app') {
      if (typeof obj.appId !== 'string') return null;
      if (typeof obj.tenantId !== 'string') return null;
      return {
        kind: 'app',
        appId: obj.appId,
        tenantId: rehydrateTenantId(obj.tenantId),
        scopes: this.coerceStringArray(obj.scopes),
        expiresAt: new Date(
          typeof obj.expiresAt === 'string'
            ? obj.expiresAt
            : Date.now() + 60 * 60 * 1000,
        ),
      };
    }
    if (obj.kind === 'user') {
      if (typeof obj.userId !== 'string') return null;
      return {
        kind: 'user',
        userId: obj.userId,
        tenantId:
          typeof obj.tenantId === 'string'
            ? rehydrateTenantId(obj.tenantId)
            : null,
        role:
          obj.role === 'OWNER' || obj.role === 'ADMIN' || obj.role === 'MEMBER'
            ? obj.role
            : null,
        scopes: this.coerceStringArray(obj.scopes),
        expiresAt: new Date(
          typeof obj.expiresAt === 'string'
            ? obj.expiresAt
            : Date.now() + 60 * 60 * 1000,
        ),
      };
    }
    return null;
  }

  private coerceStringArray(value: unknown): ReadonlyArray<string> {
    if (!Array.isArray(value)) return [];
    return value.filter((s): s is string => typeof s === 'string');
  }
}
