# Charon × Cerberus — authentication / multi-tenancy integration plan (2026-10-17)

> **Why this doc exists.** Per the user's instruction, multi-tenancy
> and authentication cannot be deferred until after the HTTP layer
> lands. Charon is a money-movement service; the rule is
> "you shouldn't be able to use charon services at all if cerberus
> doesn't authenticate you and give you authorizations." This means
> the multi-tenancy + auth wiring is **P0**, not P2.
>
> This document is the design plan for the integration, based on a
> first-pass audit of `C:/Users/Church/cerberus`. It scopes what
> needs to land before the first sandbox payment test, and what the
> charon roadmap looks like after this reshuffle.

**Sources read for this plan:**

- `C:/Users/Church/cerberus/src/authorization/interfaces/security/jwt-auth.guard.ts`
- `C:/Users/Church/cerberus/src/authorization/interfaces/security/scopes.{decorator,guard}.ts`
- `C:/Users/Church/cerberus/src/authorization/interfaces/security/{public,current-user}.decorator.ts`
- `C:/Users/Church/cerberus/src/authorization/infrastructure/crypto/jwt-signer.service.ts`
- `C:/Users/Church/cerberus/src/authorization/application/use-cases/{get-jwks,issue-access-token}.use-case.ts`
- `C:/Users/Church/cerberus/src/authorization/domain/value-objects/{user-principal,scope}.ts`
- `C:/Users/Church/cerberus/src/authorization/interfaces/http/oauth.controller.ts` (for the JWKS endpoint shape)
- `C:/Users/Church/cerberus/prisma/schema.prisma` (Organization, Membership, Role, App models)
- `C:/Users/Church/cerberus/openapi.yaml` (the V1.5 surface contract)
- `C:/Users/Church/charon` (current state, audited 2026-10-17)

---

## 1. What Cerberus gives us (no work to do on that side)

Cerberus V1.5 already ships everything Charon needs to integrate.
Concretely:

### 1.1 Bearer JWTs

- `POST /v1/auth/login` returns a refresh token + an access token
  (V1.5 short-lived JWT, signed RS256, signed by Cerberus's
  rotating signing key).
- `POST /v1/oauth/token` is the RFC 6749 standard token endpoint.
- Access tokens carry these claims (verified by reading
  `jwt-signer.service.ts:99-122` + `user-principal.ts:14-20`):
  - `sub` — userId (UUID)
  - `org` — organizationSlug (nullable, present for org-scoped tokens)
  - `role` — `OWNER | ADMIN | MEMBER | null`
  - `scope` — space-separated OAuth2 scope string
  - `exp` — standard expiry

### 1.2 JWKS endpoint

- `GET /.well-known/jwks.json` (public, no auth) returns the JWKS
  document with the public keys. Built by
  `get-jwks.use-case.ts:39-67`. Excludes private-key material
  (uses `importSPKI` for public-only import).
- Rotation: 30 days; old keys remain available for 7 days
  after rotation. Verified by `signing-key.ts` (read in audit,
  not pasted here).

### 1.3 Scope vocabulary

Cerberus defines standard scopes in
`scope.ts:11-19`:

- `auth:read` — read own profile, list own sessions
- `auth:write` — change own password, rotate own sessions
- `auth:admin` — admin operations on the user level
- `org:admin` — admin operations within an organization
- `system:admin` — cross-tenant system operations (V2)

The format is `[a-z][a-z0-9._:-]{0,63}`. **Custom scopes are
explicitly supported** — charon can mint its own.

### 1.4 Multi-tenancy

Cerberus's tenant model is `Organization` (UUID + slug) →
`Membership` (userId × organizationId × role). V1: one org per
user. V2 may add many-to-many via the existing Membership
aggregate. Charon does not need to migrate between these.

---

## 2. What Charon needs to add (the work plan)

### 2.1 P0 — must land before the first sandbox payment test

#### 2.1.1 Tenancy on the data model

Add a `tenant_id` column to every aggregate snapshot, derived
from the verified JWT's `org` claim (the organization UUID). For
V1 (one-org-per-user), the tenant_id is the organization id from
the principal. For V2 (many-to-many), it's still the org from
the principal — never the userId.

Schema changes (in a new migration after `1720000000100`):

```sql
ALTER TABLE payment_intents
  ADD COLUMN tenant_id UUID NOT NULL;
CREATE INDEX payment_intents_tenant_id_idx
  ON payment_intents(tenant_id, created_at DESC);

ALTER TABLE escrows
  ADD COLUMN tenant_id UUID NOT NULL;
CREATE INDEX escrows_tenant_id_idx
  ON escrows(tenant_id, created_at DESC);

-- The ledger stays un-tenanted for now. Per-tenant projections
-- are derived views, not separate tables. Forward decision
-- deferred.
```

The `tenant_id` is set by the use case (from the verified
principal) and is never read from the request body. The migration
backfills existing rows with a synthetic "default" tenant; that
single tenant is the only valid tenant for the V1.5 surface
until the operator runs a real-tenant-cutover migration.

#### 2.1.2 Tenant ownership on every mutation

Per the `paystack-fintech-audit.md` reference, invariant #5
("tenant ownership check, not just authentication"):

> "Defense in depth: the controller passes `tenant.id`, the
> service compares. Failure shape: the service trusts the order
> ID alone, and any tenant admin can update any other tenant's
> order by guessing IDs."

For Charon, the equivalent is:

- Every load in a use case returns an aggregate that has a
  `tenant_id` field. The use case checks
  `aggregate.tenantId === principal.tenantId` before mutating.
- Mismatch throws a typed error (`TenantMismatchError`) that
  the HTTP layer renders as 404 (NOT 403 — leaking 403 means
  the ID exists, which is information disclosure).
- The check happens inside the use case, not in the controller,
  so it cannot be bypassed by writing a new controller later.

#### 2.1.3 JWT verification at the interface boundary

The charon HTTP layer (currently not built — this is part of PR #4
in the charon README roadmap) will need a NestJS guard that mirrors
Cerberus's `JwtAuthGuard`. Specifically:

- A `CerberusAuthGuard` that calls a `JwksClient` (cached, 5-min
  TTL) to fetch `https://cerberus.example.com/.well-known/jwks.json`
- `jose.createRemoteJWKSet(new URL(jwksUri))` is the right
  primitive — handles kid resolution, key caching, and key
  rotation transparently
- Verifies `iss`, `aud`, `exp`
- Builds a `Principal` value object from the claims
  (`sub` → userId, `org` → organizationId, `role`, `scope`)
- Attaches as `req.user` (or the equivalent on the NestJS
  request context)

A new `src/interface/security/` folder with:
- `cerberus-auth.guard.ts` (the guard itself)
- `jwks-client.ts` (the JWKS fetch + cache)
- `principal.ts` (the Charon-shaped value object, mapping from
  Cerberus claims to Charon tenancy fields)
- `scopes.decorator.ts` + `scopes.guard.ts` (mirroring Cerberus's
  pattern)

#### 2.1.4 Scopes for every command endpoint

Following Cerberus's pattern, the charon command endpoints will
be guarded with `@Scopes(...)`:

- `POST /v1/payments` → `@Scopes('payments:write')`
- `GET /v1/payments/:id` → `@Scopes('payments:read')`
- `POST /v1/payments/:id/refunds` → `@Scopes('payments:refund')`
- `POST /v1/escrows` (place hold) → `@Scopes('escrows:write')`
- `POST /v1/escrows/:id/releases` → `@Scopes('escrows:release')`
- `POST /v1/escrows/:id/refunds` → `@Scopes('escrows:refund')`
- `POST /v1/escrows/:id/disputes` → `@Scopes('escrows:dispute')`
- `POST /v1/escrows/:id/cancel` → `@Scopes('escrows:cancel')`
- `GET /v1/escrows/:id` → `@Scopes('escrows:read')`

The charon scope vocabulary is charon-specific (Cerberus doesn't
mint these — it accepts custom scopes at token-issue time per
`scope.ts:19`). A new charon-side table `app_charon_scopes` (or
similar) maps which Cerberus Apps are allowed to mint which
scopes. Operators configure this on the Cerberus side via the
admin API.

#### 2.1.5 App-bound auth (machine-to-machine)

For Charon called by a backend system (not a logged-in human),
the caller is a Cerberus App, not a User. Cerberus supports this
via the `X-Cerberus-App-Id` + `X-Cerberus-App-Secret` headers
(see `openapi.yaml` and `auth.controller.ts:login`). The login
response returns a refresh token + access token carrying the
app's scopes, not a user's.

For Charon:
- A `CerberusAppAuthGuard` (parallel to the user guard) that
  reads the app headers, calls `POST /v1/auth/login` (or
  exchanges cached creds), and caches the resulting access
  token until expiry.
- The resulting principal has `userId: null`, `tenantId: <app's
  default org>`, `role: null`, `scopes: <app's granted scopes>`.
- All tenant-mismatch checks treat the app's default org as
  the tenant. (Apps may not be scoped to multiple orgs in V1.)

#### 2.1.6 Webhook endpoints stay public

Webhook endpoints (POST /v1/webhooks/paystack, etc.) are
**public** (no JWT) but verify the provider's signature per
provider's HMAC scheme. The existing webhook adapter logic
already does this (`paystack-webhook.adapter.ts`,
`stripe-webhook.adapter.ts`, `flutterwave-webhook.adapter.ts`).

After authentication lands, the webhook controllers carry
`@Public()` and the providers' signature verification is the
sole trust anchor. This matches the Cerberus pattern (`public.
decorator.ts` lists `GET /.well-known/jwks.json` and others
as public).

### 2.2 P1 — landed alongside the HTTP layer

#### 2.2.1 First outbound gateway adapter

(Already on the charon roadmap as PR #3 in the README. The
tenant context comes from the JWT, not the request body, so
the gateway adapter's reconciliation contract is unchanged:
`providerReference == NormalizedPaymentEvent.providerRef`.)

#### 2.2.2 Health endpoints

- `GET /health` — liveness. Always 200 if the process is up.
  Public (no auth).
- `GET /ready` — readiness. Returns 200 only when Postgres is
  reachable AND the JWKS client has at least one key cached.
  Public (no auth).

#### 2.2.3 Audit log on the cerberus side

The Cerberus audit log (`/v1/engagement/audit-log/me`) is per-user.
For Charon's operations, the operator running a CHARON refund or
a CHARON dispute should also produce a Cerberus audit entry.
Options:

- (a) Charon emits events to the Cerberus outbox via a new
  Cerberus webhook surface. Operator-runnable.
- (b) Charon's own audit log (a new bounded context, deferred
  to V1.5+).
- (c) Both.

(a) is the right answer for "cerberus owns the operator audit
trail". Defer (b) until a real need exists.

### 2.3 P2 — defer until real need

- **Saga / orchestration** — same as before, not blocking.
- **Provider re-verification** — same as before, not blocking.
- **Webhook inbox writer** — same as before, P1.
- **Reconciliation job** — same as before, P1.
- **Outbox pattern (charon-side, separate from Cerberus's)** —
  charon's own events for downstream subscribers. Not
  blocking.

---

## 3. The new charon roadmap (P0 reshuffled)

The previous audit listed 12 P-items. With the multi-tenancy
requirement, the order changes. The new sequence:

### PR-NN1 — Multi-tenancy data model + tenant ownership checks

Files:
- New migration `1720000000200_add-tenant-id.js`
- `payment_intents.tenant_id`, `escrows.tenant_id` columns
- `tenantId` field on `PaymentIntent` and `Escrow` aggregates
- `TenantId` branded value object in `src/shared/kernel/`
- `TenantMismatchError` typed error
- Every use case carries the `principal` through and asserts
  `aggregate.tenantId === principal.tenantId` before mutation

The use cases get a new dependency: `principal: Principal`
(typed). The aggregate constructor accepts a `tenantId` from
the principal at construction time, not from the request body.

This is a **backward-incompatible schema change**. The
migration must backfill existing rows with a synthetic tenant
UUID and reject any rows with a NULL tenant_id going forward.

### PR-NN2 — HTTP layer + Cerberus JWT verification

Files:
- `src/main.ts` (NestJS bootstrap)
- `src/app.module.ts` (composition root)
- `src/interface/security/cerberus-auth.guard.ts`
- `src/interface/security/jwks-client.ts`
- `src/interface/security/principal.ts`
- `src/interface/security/scopes.{decorator,guard}.ts`
- `src/interface/security/{public,current-principal}.decorator.ts`
- `src/interface/http/payments.controller.ts`
- `src/interface/http/escrows.controller.ts`
- `src/interface/http/webhooks.controller.ts` (public, signature
  verified per provider)
- `src/interface/http/health.controller.ts`
- `src/interface/http/dto-schemas.ts` (zod)
- `src/interface/http/dto-validation.pipe.ts`
- `src/interface/config/env.ts` (zod-validated env)

Env vars:
- `CERBERUS_BASE_URL` (e.g. `https://cerberus.example.com`)
- `CERBERUS_JWKS_URI` (defaults to
  `${CERBERUS_BASE_URL}/.well-known/jwks.json`)
- `CERBERUS_EXPECTED_AUDIENCE` (e.g. `charon`)
- `CERBERUS_EXPECTED_ISSUER` (e.g. `https://cerberus.example.com`)
- `DATABASE_URL` (already exists)
- Per-provider secrets (Paystack, Stripe, Flutterwave)

The HTTP layer is configured with the global guard:
`app.useGlobalGuards(new CerberusAuthGuard(...))`. Routes
that need to be public are marked with `@Public()`.

### PR-NN3 — First outbound gateway adapter (Paystack)

(Already on the charon roadmap. Unchanged in shape; the
principal flows through to the gateway call so the
provider's `customer` / `metadata` field carries the
tenant + user id for reconciliation.)

### PR-NN4 — Webhook inbox writer

(Already on the charon roadmap. Now with the auth in
place, the webhook controller is `@Public()` and the
inbox writer is inside the same `unitOfWork.run(...)`
as the `markProcessed` write.)

---

## 4. Scope vocabulary for charon (proposed, requires user sign-off)

Following the Cerberus pattern (`scope.ts:11-19`), charon
should expose a defined set of standard scopes that the
operator can grant to apps and users:

```
payments:read     - read own / own-org payment intents
payments:write    - create a new payment intent
payments:refund   - issue a refund against a settled intent
escrows:read      - read own / own-org escrow state
escrows:write     - place a hold (create a new escrow)
escrows:release   - release held funds to the seller
escrows:refund    - refund held funds to the buyer
escrows:dispute   - open a dispute on a held escrow
escrows:cancel    - cancel a PENDING escrow
```

The vocabulary is **flat** (not nested) so it composes
cleanly with Cerberus's `hasAllScopes` semantics. Granular
operations are explicit — no umbrella scope like
`payments:admin` that grants all payment permissions.

Open question: do we need an `admin` scope that bypasses
tenant ownership checks for operator-only flows
(force-refund, force-cancel)? If yes, propose
`payments:admin` and `escrows:admin` as super-user scopes
that the operator user holds and Apps do NOT.

---

## 5. Open questions for the user (decision needed before PR-NN1)

1. **Tenant ID source.** For V1, the principal's `org` claim
   (a slug like `acme-corp`) needs to resolve to a UUID that
   goes into the `tenant_id` column. Two options:
   - (a) JWT carries the org UUID directly (Cerberus would
     need to mint the `org` claim as a UUID, not a slug —
     small Cerberus-side change).
   - (b) Charon maintains its own
     `organization_slug → organization_id` table, populated
     by an admin operator. The principal's slug is looked
     up on every request and the result is cached in
     memory.
   Recommendation: (a). Cerberus already has the `Organization`
   aggregate; adding the UUID to the JWT claim is a 5-line
   Cerberus change.
2. **App-bound tenant scope.** When a Cerberus App calls
   Charon, what tenant do they act on? Options:
   - (a) The app's `defaultOrgSlug` (one tenant per app).
   - (b) The `X-Org-Id` request header (one app can act on
     many tenants).
   - (c) Both, with the header as override.
   Recommendation: (a) for V1, (c) for V2.
3. **App scopes source.** When a Cerberus App logs in and
   gets a token, the scopes come from where? Currently
   Cerberus doesn't seem to bind scopes to apps. Options:
   - (a) A new `app_charon_scopes` table in Charon mapping
     `(cerberus_app_id) → (scope[])`. Charon reads it on
     every app request.
   - (b) Scope granted at app-registration time in Cerberus,
     via a new `allowed_scopes` field on the `App` model.
   Recommendation: (b) — one source of truth.
4. **MFA enforcement for charon.** Should Charon require
   that the caller's session has `mfaVerified = true`? The
   JWT doesn't currently carry an `mfaVerified` claim (the
   MFA flow on Cerberus returns `mfaRequired: true` and
   forces a second call to `/v1/identity/mfa/verify`).
   Recommendation: V1, don't enforce MFA on Charon — Cerberus
   does. Add the claim in Cerberus V2 if needed.
5. **Audit trail.** When a CHARON refund runs, the
   Cerberus audit log should reflect that the operator
   (or app) took a destructive action on the tenant's
   payments. Today Cerberus has no inbound webhook surface
   for Charon to push audit events to. Options:
   - (a) Cerberus adds a `POST /v1/internal/audit` endpoint
     that an authenticated Charon service can write to.
   - (b) Charon's own audit log (new bounded context).
   - (c) Both.
   Recommendation: (a) for V1.

---

## 6. What the live integration looks like end-to-end

```
[Calling App / Browser]
   |
   |  POST /v1/auth/login
   v
[Cerberus :3000]  -- login + MFA check + JWT mint
   |
   |  { accessToken, refreshToken, sessionId, ... }
   v
[Caller now sends]
   |  POST /v1/payments
   |  Authorization: Bearer <accessToken>
   v
[Charon :3000]  -- CerberusAuthGuard
   |  - extract Bearer token
   |  - fetch JWKS from Cerberus (cached)
   |  - verify signature + iss + aud + exp
   |  - build Principal { userId, tenantId, role, scopes }
   |  - check @Scopes('payments:write')
   |  - ScopesGuard: hasAllScopes(principal, ['payments:write'])
   |  - tenant ownership: ensure payment_intent.tenant_id === principal.tenantId
   v
[Charon InitiatePaymentUseCase]
   |  - acquire IdempotencyStore (with tenantId-scoped key prefix)
   |  - route to provider
   |  - call PaymentGatewayPort.initializeCharge(...)
   |  - persist PaymentIntent with tenantId
   |  - journal to ledger (un-tenanted)
   v
[Charon returns]  -- { intentId, status, provider, amount, ... }
```

The same shape applies for every command endpoint. Webhooks
follow the same path but `@Public()` and verify the provider
signature instead.

---

## 7. What is not changing

To be explicit about what stays the same:

- **Money is integer-only.** No float anywhere. (Verified
  in 2026-10-17 audit §7.1.)
- **Append-only ledger with per-aggregate sequence.** The
  ledger is un-tenanted (a single global journal). Per-tenant
  projections are derived views, not separate tables.
- **Idempotency keys are scoped per use case, not per
  tenant.** The `idempotency_keys` table is global; the
  `(scope, key)` PK is unchanged. Tenant scoping on
  idempotency is not required because the tenant is
  derived from the verified principal at the controller
  layer, not from the request body. (A future enhancement
  could add `tenantId` to the PK if multi-tenant
  idempotency-key collisions become a real issue.)
- **Optimistic concurrency via `version` column.** Now also
  indexed by `(tenant_id, version)` for tenant-scoped
  queries. The version bump logic is unchanged.
- **Webhook signature over raw body.** Already implemented;
  unchanged.

---

## 8. Verification plan (when this lands)

When PR-NN1 (tenancy) lands:

1. Migration runs cleanly on a fresh DB.
2. Every use-case spec passes a new "different tenant
   cannot mutate" assertion. (Add a fixture that loads
   the same aggregate with a different tenantId and
   asserts `TenantMismatchError` is thrown.)
3. Integration spec runs the full charge → webhook
   → escrow lifecycle under one tenant, then runs a
   second cycle under a different tenant and asserts
   the second cycle's data is invisible to the first.

When PR-NN2 (HTTP + JWT) lands:

1. `GET /health` returns 200 without a token.
2. `GET /v1/payments/:id` without a token returns 401
   `authentication.token.missing`.
3. With a Cerberus-issued token, `GET /v1/payments/:id`
   returns the resource.
4. With a token from a different tenant, returns 404
   (NOT 403, to avoid ID-disclosure).
5. With a token missing the required scope, returns
   401 `insufficient_scope`.

When PR-NN3 (gateway) lands:

1. Sandbox charge against Paystack test mode succeeds.
2. The provider's webhook arrives and Charon
   transitions the intent to SUCCEEDED.
3. The escrow hold runs only on the tenant that owns
   the intent.

---

## 9. Risk register

Three risks specific to this integration:

1. **Cerberus's V1.5 audience claim.** Today Cerberus
   uses a single `audienceDefault` for all tokens. Charon
   needs its own audience (`charon`) so a token minted
   for a different Cerberus consumer cannot be replayed
   against Charon. **Verify with the user:** does
   Cerberus support per-audience minting, or do we need
   to extend it?

2. **Signing-key rotation grace period.** Cerberus rotates
   every 30 days; old keys are valid for 7 days. Charon's
   JWKS client needs to cache the full key set, not
   just the current key. `jose.createRemoteJWKSet` does
   this correctly by default. Verified in
   `jwksClient` design.

3. **Refresh-token rotation at Cerberus.** If a caller's
   refresh token is rotated, the access token may still
   be valid until its `exp`. Charon has no way to know
   the token was rotated mid-flight. Mitigation: short
   access-token TTL (Cerberus default is 15 min; Charon
   can require `exp` < some bound if it wants tighter).

---

## 10. What I am NOT going to do without the user

This document is a plan. No code is being written yet. Per
the standing rule ("stage work + stop, never commit unless
told"), the next action is the user choosing which of the
five open questions in §5 to answer, and which of the four
proposed scopes in §4 to keep. Once those are settled,
PR-NN1 is ready to start.

If the user wants the plan committed as a doc-only PR for
review, that is also a valid next action — but I will not
stage it without the user asking.
