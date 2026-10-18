# Charon — Cerberus auth integration design (2026-10-17, V1.6 ready)

> **Why this doc exists.** The previous integration plan
> (`2026-10-17-cerberus-integration-plan.md`) and the
> client-credentials addendum
> (`2026-10-17-cerberus-client-credentials.md`) established the
> OAuth2 pattern the user wanted: the org's environment holds
> `CERBERUS_CLIENT_ID` + `CERBERUS_CLIENT_SECRET`, mints a
> short-lived JWT via Cerberus's `client_credentials` grant, and
> Charon validates that JWT on every inbound call via JWKS.
>
> Cerberus V1.6 (`commit 68b4863 feat(oauth): V1.6 client_credentials grant`)
> is now in `origin/master`. This doc is the **Charon-side
> contract** for that flow: the exact JWT claim shape, the
> principal mapping, the scope vocabulary, the cache strategy,
> and the 5 open questions from the previous plan that are now
> closed.
>
> **Status: design only, no code yet.** Per the standing rule
> ("stage work + stop, never commit unless told"), the user picks
> the answers to the remaining decisions in §6, then PR-NN2
> (HTTP layer + JWT verification) can start.

## 1. The full claim shape (verified against V1.6 source)

`src/authorization/application/use-cases/issue-client-credentials-access-token.use-case.ts:153-163`
confirms the payload Cerberus mints for `client_credentials`:

```ts
{
  // Standard JWT claims
  iss:    'https://cerberus.example.com',  // AppConfig.jwt.issuer
  aud:    'charon',                          // AppConfig.jwt.audienceDefault (or per-app override)
  iat:    1731000000,
  exp:    1731000900,                        // iat + ttlSeconds
  jti:    'c1c2...',                         // unique token id (for denylist)

  // Custom claims
  sub:    '8b3f4a7c-...',                    // App UUID (the "sub" is the App, not a User)
  typ:    'app',                              // explicit — lets Charon distinguish from user-bound tokens
  appId:  '8b3f4a7c-...',                    // duplicate of `sub` per V1.6 spec
  org:    'a1b2c3d4-...',                    // Organization UUID; null if App.defaultOrgSlug is null
  role:   null,                              // apps have no org role
  scope:  'payments:write escrows:release',  // space-separated, intersected with App.allowedScopes
}
```

`alg: 'RS256'` (verified at `signing-key.ts:14` and
`rotate-signing-key.use-case.ts:72`). JWKS at
`GET /.well-known/jwks.json` (`oauth.controller.ts:209`).

## 2. The Principal value object (Charon side)

This is the typed wrapper Charon's use cases will receive. The
mapping from JWT claim → Principal is verified in the adapter;
the use cases consume the typed value, never raw claims.

```ts
// src/interface/security/principal.ts
export type Principal =
  | {
      kind: 'app';
      appId: string;              // UUID; the App's `sub` / `appId`
      tenantId: string;           // UUID; the App's resolved Organization
      scopes: ReadonlyArray<string>;
      expiresAt: Date;
    }
  | {
      kind: 'user';
      userId: string;             // UUID; user's `sub`
      tenantId: string | null;    // user's `org`
      role: 'OWNER' | 'ADMIN' | 'MEMBER' | null;
      scopes: ReadonlyArray<string>;
      expiresAt: Date;
    };

export function hasAllScopes(
  principal: Principal,
  required: ReadonlyArray<string>,
): boolean;
```

**Why a discriminated union:** the two token kinds have different
fields (`role` is meaningful for users, irrelevant for apps;
`tenantId` is mandatory for app-bound because the App is
always scoped to its `defaultOrgSlug`, but nullable for users
in V1). One flat type with `role?: null` and `tenantId?: string`
loses the type-safety win.

**The discriminator is `typ: 'app' | 'user'`.** Cerberus V1.6
already mints `typ: 'app'` for the new grant and `typ: 'user'`
for the existing password/refresh grants
(verified at `issue-access-token.use-case.ts:143`). Charon's
JWKS verifier reads the claim, decodes to the right variant,
and the use cases are typed accordingly.

## 3. The scope vocabulary (charon-specific)

Cerberus's scope VO at
`src/authorization/domain/value-objects/scope.ts:11-19` accepts
**any** `[a-z][a-z0-9._:-]{0,63}` token — custom scopes are
explicitly supported. So charon defines its own vocabulary and
Cerberus mints them at app-register time (the new
`App.allowedScopes` column, defaulting to empty).

**Per-org access is enforced at the App level.** Every org that
wants to call charon must register its own Cerberus App and
have the operator grant the right scopes. The org holds its
`client_id` + `client_secret` in its own vault; charon never
sees the secret. The `org` claim in the minted JWT is bound
to that App's `defaultOrgSlug`, so a token minted by App A
only authenticates against App A's data — App B cannot mint
a token that bypasses App A's tenant boundary.

```
payments:read       - read own / own-org payment intents
payments:write      - create a new payment intent
payments:refund     - issue a refund against a settled intent
escrows:read        - read own / own-org escrow state
escrows:write       - place a hold (create a new escrow)
escrows:release     - release held funds to the seller
escrows:refund      - refund held funds to the buyer
escrows:dispute     - open a dispute on a held escrow
escrows:cancel      - cancel a PENDING escrow
```

Flat (not nested) so it composes cleanly with Cerberus's
`hasAllScopes` (the entire space-sep string is intersected
with the App's allowlist at mint time).

The V1.6 spec confirms: an App registered with
`initialScopes: ['payments:read', 'escrows:read']` can
authenticate (mint a token) but the resulting token carries
`scope: 'payments:read escrows:read'` only — anything else
gets dropped at the grant step. A Charon endpoint that requires
`payments:write` returns 401 `insufficient_scope` to a
read-only App.

## 4. The inbound auth flow (resource server pattern)

```
[Caller] --(client_credentials grant)--> [Cerberus :3000]
                    |                               |
                    | (one-time, on process start)  |
                    v                               v
                [Charon]                  { access_token, expires_in: 900 }
                    |                               ^
                    |   Charon's inbound path:     |
                    |   no, this is OUTBOUND.      |
                    |                               |
        Caller's own JWT (or App's JWT)  --------+
                    |
                    | --POST /v1/payments, Authorization: Bearer <jwt>-->
                    v
              [Charon :3000]
                    |
                    | --JWKS GET (cached 5min)--> [Cerberus :3000]
                    v
              [CerberusAuthGuard]
                    1. Extract Bearer
                    2. JWKS verify (kid-resolved)
                    3. iss / aud / exp checks
                    4. Build Principal from claims
                    5. @Scopes('payments:write')  ──  Cerberus ScopesGuard
                    6. attach as req.principal
                    7. controller hands principal.tenantId to use case
                    8. use case: aggregate.tenantId === principal.tenantId
                       (TenantMismatchError → 404, not 403, to avoid ID disclosure)
                    v
                 [use case runs]
```

**Two distinct roles for the JWT:**

1. **Caller's own JWT** — the org's backend or CI pipeline mints
   one (via `client_credentials`) and sends it to Charon. Charon
   validates it on every inbound call. The secret stays in the
   caller's vault; Charon never sees it.
2. **Charon's own JWT (future, for outbound Paystack calls)** —
   when the Paystack gateway adapter needs to authenticate to
   Paystack, Charon mints its own `client_credentials` token and
   uses it. This is a *separate* call pattern and only matters
   when the gateway starts carrying per-call auth headers.

For the V1.6 integration, **only #1 is in scope.** #2 is a future
optimization that mostly matters if Paystack moves from
secret-key auth to short-lived tokens; today Paystack uses
`Authorization: Bearer <secret-key>` which we already support.

## 5. The outbound auth flow (Charon's `CerberusClient`)

The composition root holds a single `CerberusClient` per process
that:

```ts
// src/interface/security/cerberus-client.ts (future, PR-NN2+)
export class CerberusClient {
  private cached: { token: string; expiresAt: Date } | null = null;
  constructor(
    private readonly baseUrl: string,
    private readonly clientId: string,
    private readonly clientSecret: string,
    private readonly http: HttpClient,   // same HttpClient port the gateway uses
    private readonly clock: Clock,        // injectable for tests
  ) {}

  async getAccessToken(scope: string): Promise<Result<string, DomainError>> {
    // 1. If cached && expiresAt - 60s > now → return cached
    // 2. POST /v1/oauth/token (form-encoded, grant_type=client_credentials)
    // 3. Parse response, cache, return
    // 4. On 401 from any future inbound call → invalidate, retry once
  }
}
```

Single-flight per `(client_id, scope)` tuple. The cache key
includes scope because an app with multiple desired operations
might mint multiple tokens. Charon's composition root supplies
one CerberusClient instance; it's stateless apart from the cache.

**Why this is not in V1.6 scope:** the current Paystack gateway
adapter uses `Authorization: Bearer <PAYSTACK_SECRET_KEY>` (a
static long-lived key, not an OAuth2 token). The `CerberusClient`
becomes useful when Charon calls Cerberus for things like pushing
audit entries or fetching user profiles — neither is in the
current plan. PR-NN2 ships the inbound path; PR-NN2+ ships the
outbound client.

## 6. Decisions closed since the previous plan

The 5 open questions from
`docs/audits/2026-10-17-cerberus-integration-plan.md` §5:

| # | Question | Closed by |
|---|---|---|
| 1 | Tenant ID source in the JWT (slug vs UUID) | **UUID** — V1.6 `issue-client-credentials-access-token.use-case.ts:111` reads `membership.organizationId.value` (Cerberus's `OrgId` UUID, not the slug). |
| 2 | App-bound tenant scope (default org vs `X-Org-Id`) | **Default org only in V1.6.** Cerberus's token has one `org` claim. Multi-org apps wait for V2. |
| 3 | App scopes source (Cerberus column vs charon table) | **Cerberus column** — V1.6 added `App.allowedScopes VARCHAR(1024)`. No charon-side table needed. |
| 4 | MFA enforcement for charon | **Deferred to V2** — Cerberus already handles MFA on the user grant; the app grant has no MFA. |
| 5 | Audit log on charon operations | **Open for now** — V1.6 records `app.token.issued` on the Cerberus side. The "charon action → cerberus audit" push is a future Cerberus-PR. |

Plus the integration plan's open question I asked earlier:

| # | Question | Closed by |
|---|---|---|
| 6 | `typ` claim for user vs app distinction | **`typ: 'app' | 'user'` is already in the JWT.** V1.6 mints `'app'`; existing user grants mint `'user'`. Charon's `Principal` discriminator uses this. |

## 7. The 3 questions still open (need user decisions before PR-NN2)

### Q1. Where does the tenant come from for app-bound tokens?

Cerberus mints the token with `org = <App.defaultOrgSlug's UUID>`.
Charon's `tenantId` column gets this UUID directly — no
slug→UUID mapping table needed in charon.

**But:** Cerberus's `OrgId` UUID and Charon's `tenantId` UUID are
independent. If a user migrates between Cerberus orgs, the JWT's
`org` changes but Charon's historical `tenant_id` columns
still point to the old UUID. For V1, both repos assume the
Cerberus org UUID is the source of truth and never changes. The
V1 `Organization` aggregate in Cerberus doesn't have a soft-delete
or migration path either.

**Decision needed:** if Cerberus orgs can be renamed + have
their `Organization.uuid` changed (DANGEROUS — would orphan
every charon row), Charon needs a `tenant_slug → tenant_id`
mapping table. **Recommendation: no — document "org UUID is
immutable" in both repos' READMEs. Add a Cerberus validation
guard in V1.6.1 to reject UUID changes on Organization
update.**

### Q2. Audience claim (`aud`) — what `aud` the token carries

This is **separate** from "per-app connection to charon" — that
isolation is already provided by `client_credentials`: every org
that wants charon has its own App (own `client_id`, own
`client_secret`, own `allowedScopes`, own `defaultOrgSlug`).
The secret is held in the org's vault, never in charon's env.
A token minted by App A is bound to App A's `defaultOrgSlug`,
so App A cannot mint a token that authenticates against
App B's data. The "not every org wants to use charon" question
is already answered: an org has to be registered in Cerberus,
with the right scopes, to mint a working token at all.

What's still open is the **`aud` value** the token carries.
Today Cerberus mints `aud = AppConfig.jwt.audienceDefault`
— one value for the whole deployment. That matters when:

- You run **one** charon deployment per Cerberus: any `aud`
  string is fine, just match charon's `CERBERUS_JWT_AUDIENCE`
  env var to Cerberus's `jwt.audienceDefault`.
- You run **multiple** charon deployments against one Cerberus
  (e.g. `charon-prod` and `charon-staging`): you want a
  token minted for `charon-staging` to fail on `charon-prod`.
  In V1.6 every charon is happy with the same `aud` because
  they're isolated by deployment, not by token claim. To make
  a token fail cross-environment, the operator sets
  `CERBERUS_JWT_AUDIENCE=charon-prod` on prod and
  `CERBERUS_JWT_AUDIENCE=charon-staging` on staging, and
  Cerberus's `jwt.audienceDefault` must match.

**Per-app `aud` would mean each registered App declares which
charon(s) it can call.** That's an extension to V1.6's grant
and an additional field on the `App` model. Not needed for V1.

**Decision needed:** confirm per-deployment `aud` is the
intended shape. **Recommendation: yes, per-deployment `aud`,
set via env on both sides. No Cerberus-side change needed.**
Charon reads `CERBERUS_JWT_AUDIENCE` from env at startup;
Cerberus's `jwt.audienceDefault` is set once per Cerberus
deployment (matches the matching charon deployment's env).

### Q3. `gateways` Map keyed by ProviderName — out of scope for the auth PR

`InitiatePaymentUseCase` now takes a
`gateways: ReadonlyMap<ProviderName, PaymentGatewayPort>` —
this was added in the Paystack gateway PR. The auth PR doesn't
change this; it just adds the inbound principal that *passes*
through the use cases. **No additional decision needed for the
auth PR** — the gateway map is already in the right shape.

(If the gateway adapter needs to make outbound calls to
Paystack, that's a separate concern handled inside
`PaystackGatewayAdapter`. The Paystack secret-key auth is
unchanged. Future `CerberusClient` integration is for *charon's*
outbound calls, not the gateway's.)

## 8. What PR-NN2 ships (the inbound auth PR)

Once Q1, Q2 are settled, PR-NN2 is the HTTP layer + JWT
verification. The work breakdown:

**New files (in `src/interface/security/`):**

- `principal.ts` — the `Principal` union from §2
- `cerberus-auth.guard.ts` — NestJS `CanActivate` extracting
  Bearer, verifying via JwksClient, building Principal
- `jwks-client.ts` — fetches `/.well-known/jwks.json`, caches
  for 5 min, kid-based key resolution (uses `jose.createRemoteJWKSet`
  under the hood)
- `scopes.decorator.ts` + `scopes.guard.ts` — mirror Cerberus's
  pattern: `@Scopes('payments:write')` + 401 `insufficient_scope`
- `public.decorator.ts` — `@Public()` for unauthenticated
  endpoints (webhook receivers, health)
- `current-principal.decorator.ts` — extracts Principal from
  `req.principal` for handler injection

**Modified files:**

- `src/payments/application/initiate-payment.use-case.ts` (and
  every other use case) — add a `principal: Principal` param
  via the deps interface, use `principal.tenantId` to set
  the aggregate's `tenantId`
- `src/payments/domain/payment-intent.ts` + `src/escrow/domain/escrow.ts`
  — add a `tenantId: string` field on the constructor + snapshot
- `migrations/1720000000200_add-tenant-id.js` — `tenant_id UUID
  NOT NULL` on `payment_intents` and `escrows` + indexes
- `src/main.ts` + `src/app.module.ts` — NestJS bootstrap +
  composition root binding every port to its adapter
- `src/interface/http/payments.controller.ts` (and escrow,
  webhooks, health) — DTOs, validation pipes, the actual HTTP
  surface

**Test fakes updated:**

- 4 spec files need a new `RecordingPrincipal` or similar
  (already covered by the recent `RecordingGatewayAdapter`
  pattern; same approach)

**Verification:**

- `GET /health` (public) returns 200 without a token
- `GET /v1/payments/:id` without a token → 401 `authentication.token.missing`
- With a token but wrong tenant → 404 (not 403, no ID disclosure)
- With a token missing the required scope → 401 `insufficient_scope`
- JWKS rotation: a 30-day key rotation on Cerberus rolls over
  with no Charon code change (the 5-min cache re-fetches)

## 9. What is NOT in PR-NN2 (deferred)

- **`CerberusClient`** (§5) — the outbound token-minter. Useful
  only when Charon calls Cerberus for things like audit-entry
  push or user-profile lookup. PR-NN2 doesn't need it.
- **Tenancy data model on aggregates** — this is **PR-NN1** in
  the new roadmap, which is a different PR. PR-NN2 assumes
  PR-NN1 has already landed (otherwise the `tenant_id` field
  doesn't exist on the aggregate).
- **TenantMismatchError check** — same as above, PR-NN1
  territory.

## 10. Recommended sequencing

The cleanest order:

1. **PR-NN1** (tenancy data model): `tenant_id` column on
   `payment_intents` and `escrows` + `TenantId` VO +
   `TenantMismatchError` typed error + every use case asserts
   the principal's tenant. **No auth code.** This is the
   blocking piece for the auth PR (the use case can't take
   `principal.tenantId` until the column exists).
2. **PR-NN2** (this doc): Cerberus inbound auth + HTTP layer.
3. **PR-NN3** (Paystack gateway adapter): the gateway is
   already shipped, but PR-NN3 is when the
   `MarkProcessing → ProviderReference → webhook reconciliation`
   loop gets end-to-end coverage.
4. **PR-NN4** (webhook inbox writer): already shipped but
   unverified end-to-end.
5. **PR-NN5** (Cerberus outbound): `CerberusClient`,
   `POST /v1/internal/audit` push, the rest.

The user has been running PR-NN3 and PR-NN4 in parallel with
the Cerberus V1.6 work. PR-NN1 is the next linear dependency.

## 7. Open questions that MUST be settled before PR-NN1 can start

The 6 questions I had open at the end of §6 are now closed. The
final two — Q1 (org UUID immutability) and Q2 (audience
strategy) — are settled as follows:

### Q1 closed: Organization UUID is already immutable

Verified across all three layers:

- **Domain layer** (`identity/domain/aggregates/organization.ts`):
  `id: OrgId` is `readonly`, and the only mutator method is
  `rename(clock, name)` which does not touch `id`. No
  `withId` / `setId` / `changeId` method exists.
- **Repository layer**
  (`identity/infrastructure/persistence/prisma-organization.repository.ts:54-66`):
  the upsert's `update` payload is
  `{ slug, name }` — `id` is omitted, so Prisma cannot change
  the PK via the `update` API.
- **Schema layer** (`prisma/schema.prisma`):
  `id String @id @default(uuid())` — Prisma's `@id` is the
  primary key and `update` cannot change it.

**No code change needed for Q1.** The immutability is enforced
structurally. Add a comment to `Organization.rename()` to make
the invariant explicit (one-line doc-only change, not blocking).

### Q2 closed: per-deployment `aud`

Confirmed in §3 and §6. Each charon deployment reads
`CERBERUS_JWT_AUDIENCE` from env; Cerberus's `jwt.audienceDefault`
is set to match. A token minted for `charon-staging` will fail
on `charon-prod` because their audiences differ. No Cerberus
code change needed.

**No blocking questions remain.** PR-NN1 can start.

The next concrete action is to start on the **tenancy data
model** (PR-NN1):
- `tenant_id UUID NOT NULL` column on `payment_intents` and
  `escrows` (new migration `1720000000200_add-tenant-id.js`)
- `TenantId` branded value object in `src/shared/kernel/`
- `TenantMismatchError` typed error in `src/shared/kernel/`
- `tenantId` field on `PaymentIntent` and `Escrow` aggregates
- Repository serialization (insert + select) for the new column
- Every use case's `Deps` interface gets a `principal: Principal`
  field; the use case asserts `aggregate.tenantId === principal.tenantId`
  before mutation

Per §5 of the design doc, the `Principal` type is the
discriminated union:

```ts
type Principal =
  | { kind: 'app'; appId: string; tenantId: string; scopes: ReadonlyArray<string>; expiresAt: Date }
  | { kind: 'user'; userId: string; tenantId: string | null; role: 'OWNER' | 'ADMIN' | 'MEMBER' | null; scopes: ReadonlyArray<string>; expiresAt: Date };
```

For PR-NN1, the only thing the use cases need from `Principal` is
`tenantId`. The full `kind: 'app' | 'user'` discriminator waits
for PR-NN2.
