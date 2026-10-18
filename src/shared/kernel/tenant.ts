import { DomainError } from './domain-error';
import { err, ok, type Result } from './result';

/**
 * The Cerberus Organization UUID this aggregate (payment intent,
 * escrow) belongs to. Mirrored from Cerberus V1.6's
 * `App.defaultOrgSlug` resolved to a `Organization.id` UUID.
 *
 * The OrgId is treated as IMMUTABLE across both repos:
 *   - Cerberus's `Organization` aggregate has `id: readonly` and no
 *     `setId` method.
 *   - Cerberus's Prisma repository's `upsert.update` payload omits
 *     `id`, so the PK cannot change via the update API.
 *   - Charon never writes `tenantId` from the boundary; it only
 *     reads it from the verified JWT's `org` claim and asserts
 *     that the aggregate's `tenantId` matches.
 *
 * If a future migration needs to change the Cerberus OrgId (DON'T),
 * the migration would need to: (a) block at the Cerberus side, (b)
 * backfill all charon `tenant_id` columns, and (c) invalidate every
 * outstanding JWT. Treat this as a hard invariant.
 */
export type TenantId = string & { readonly __brand: 'TenantId' };

/**
 * UUID v4 + v5 (RFC 4122). Node-postgres returns lowercase
 * canonical form from `pg_type` casts, but we don't trust the
 * driver — normalize to lowercase before comparison so `OrgA...`
 * and `orga...` (both legal strings) match.
 */
const TENANT_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export class InvalidTenantIdError extends DomainError {
  readonly code = 'INVALID_TENANT_ID';

  constructor(raw: string) {
    super(`TenantId must be a UUID string; got ${JSON.stringify(raw)}`);
  }
}

export function parseTenantId(
  raw: string,
): Result<TenantId, InvalidTenantIdError> {
  if (typeof raw !== 'string' || !TENANT_PATTERN.test(raw)) {
    return err(new InvalidTenantIdError(raw));
  }
  return ok(raw as TenantId);
}

/**
 * Construct a {@link TenantId} from a string that has already been
 * validated. Used by repository rehydration (we trust the DB row
 * to hold a canonical UUID; the column is `uuid` typed) and by
 * JWT-claim deserialization (we trust the `org` claim because
 * Cerberus signed it with a key only it holds).
 *
 * Will throw on malformed input — the call sites that use this
 * helper run at the boundary between a trusted source and the
 * domain, so a thrown error is the right behavior.
 */
export function rehydrateTenantId(raw: string): TenantId {
  if (typeof raw !== 'string' || !TENANT_PATTERN.test(raw)) {
    throw new InvalidTenantIdError(raw);
  }
  return raw as TenantId;
}

/**
 * The authenticated caller. Discriminated by `kind` so use cases
 * can type-narrow on the kind of token that authorized the call.
 *
 * For PR-NN1 the only field the use cases consume is `tenantId`.
 * The full `{ kind: 'app' | 'user' }` discriminator and
 * `appId`/`userId`/`role`/`scopes` fields will be exercised in
 * PR-NN2 once the HTTP layer + CerberusAuthGuard land.
 *
 * Today (during the PR-NN1 cutover), the composition root builds
 * `Principal` instances by reading the verified JWT directly. The
 * use cases consume the typed value and never see raw claims.
 */
export type Principal =
  | {
      readonly kind: 'app';
      /** Cerberus App UUID (the token's `sub` / `appId`). */
      readonly appId: string;
      /** The tenant the App is bound to via `defaultOrgSlug`. */
      readonly tenantId: TenantId;
      /** Scopes the App is allowed to claim. */
      readonly scopes: ReadonlyArray<string>;
      readonly expiresAt: Date;
    }
  | {
      readonly kind: 'user';
      /** Cerberus User UUID (the token's `sub`). */
      readonly userId: string;
      /** The user's org; null for users without a tenant binding. */
      readonly tenantId: TenantId | null;
      readonly role: 'OWNER' | 'ADMIN' | 'MEMBER' | null;
      readonly scopes: ReadonlyArray<string>;
      readonly expiresAt: Date;
    };

/**
 * Narrows a {@link Principal} to its tenant id, throwing if the
 * principal has no tenant binding. Use cases that create a new
 * aggregate (e.g. {@link InitiatePaymentUseCase}) call this once
 * at the start of the pipeline and use the result as the
 * `tenantId` on the freshly-created aggregate.
 *
 * The V1 invariant is: every authenticated principal has a
 * tenant. The only way to land here with `tenantId: null` is to
 * be a user without an org binding — V1 of the Cerberus user
 * grant (password / refresh_token) always mints `org` for users
 * with an org membership, so a `null` tenant is a config bug
 * upstream (a user was registered without a membership) and
 * throwing is the right behavior.
 */
export class UnboundPrincipalError extends DomainError {
  readonly code = 'UNBOUND_PRINCIPAL';

  constructor() {
    super(
      'Principal has no tenant binding; V1 requires every caller to be tenant-scoped',
    );
  }
}

export function requireTenant(principal: Principal): TenantId {
  if (principal.tenantId === null) {
    throw new UnboundPrincipalError();
  }
  return principal.tenantId;
}

/**
 * Equality is the only meaningful comparison between Principals —
 * tests use it to assert "this use case was called with exactly
 * this principal". No ordering, no hashing, no canonicalization.
 */
export function principalsEqual(a: Principal, b: Principal): boolean {
  if (a.kind !== b.kind) return false;
  if (a.expiresAt.getTime() !== b.expiresAt.getTime()) return false;
  if (a.scopes.length !== b.scopes.length) return false;
  for (let i = 0; i < a.scopes.length; i++) {
    if (a.scopes[i] !== b.scopes[i]) return false;
  }
  if (a.kind === 'app' && b.kind === 'app') {
    return a.appId === b.appId && a.tenantId === b.tenantId;
  }
  if (a.kind === 'user' && b.kind === 'user') {
    return (
      a.userId === b.userId && a.tenantId === b.tenantId && a.role === b.role
    );
  }
  return false;
}

/**
 * Throw if the principal's tenant doesn't match the aggregate's
 * tenant. The error is rendered as 404, not 403, at the HTTP
 * boundary: returning 403 would leak the existence of the
 * aggregate to a caller that doesn't own it.
 */
export class TenantMismatchError extends DomainError {
  readonly code = 'TENANT_MISMATCH';

  constructor(
    readonly expected: TenantId,
    readonly actual: TenantId | null,
  ) {
    super(
      `Tenant mismatch: aggregate belongs to ${expected}, principal is ${
        actual ?? '<no-tenant>'
      }`,
    );
  }
}

/**
 * Assert the principal can act on an aggregate owned by `tenantId`.
 * Returns `ok(undefined)` on success, `err(TenantMismatchError)`
 * otherwise. Use cases that mutate aggregates MUST call this before
 * the state change.
 *
 * Three rules:
 *  1. App-bound principals (`kind: 'app'`): the principal's
 *     `tenantId` MUST equal the aggregate's `tenantId`. There's no
 *     concept of "an App acting without a tenant" — every App has
 *     a `defaultOrgSlug` by V1.6 spec.
 *  2. User-bound principals (`kind: 'user'`) with a `tenantId`:
 *     same as the App rule.
 *  3. User-bound principals without a `tenantId` (V1
 *     "user without org"): can only act on aggregates that
 *     also have no tenant. In PR-NN1 we always have a tenant, so
 *     this branch never matches; the call always errors. This
 *     branch exists for the V2 case where user-bound actions
 *     cross-tenant.
 */
export function assertTenantOwnership(
  principal: Principal,
  aggregateTenantId: TenantId,
): Result<void, TenantMismatchError> {
  if (principal.tenantId === null) {
    return err(new TenantMismatchError(aggregateTenantId, null));
  }
  if (principal.tenantId !== aggregateTenantId) {
    return err(new TenantMismatchError(aggregateTenantId, principal.tenantId));
  }
  return ok(undefined);
}
