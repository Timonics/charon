# Charon × Cerberus — Client Credentials flow (2026-10-17, addendum)

> **Why this addendum exists.** The earlier integration plan
> (`2026-10-17-cerberus-integration-plan.md`) proposed two parallel
> auth patterns: user JWTs via JWKS for end-users, and a
> "CerberusAppAuthGuard" that re-sent the `X-Cerberus-App-Id` +
> `X-Cerberus-App-Secret` headers on every request. The user
> corrected this with the right pattern: the org's app credentials
> live in their environment, they mint a short-lived JWT once
> via OAuth2's `client_credentials` grant, and the JWT is what
> Charon validates. This addendum replaces the app-secret-on-
> every-request pattern with the standard OAuth2 resource-server
> pattern.

## 1. The flow the user described (and why it's right)

```
[Org's env / k8s secret]
  X_CERBERUS_APP_ID=<uuid>
  X_CERBERUS_APP_SECRET=<plaintext key>
            |
            | (1) one-time: org's service mints a JWT
            v
[Charon :3000]  -- client_credentials grant --> [Cerberus :3000]
                       grant_type=client_credentials
                       client_id=$X_CERBERUS_APP_ID
                       client_secret=$X_CERBERUS_APP_SECRET
                       scope=payments:write escrows:release
                                                 |
                                                 v
                                       { access_token: <JWT>,
                                         token_type: "Bearer",
                                         expires_in: 900,
                                         scope: "payments:write escrows:release" }
            |
            | (2) every request: Charon validates the JWT
            v
[Charon :3000]  -- JWKS GET (cached) --> [Cerberus :3000]
                       /.well-known/jwks.json
                                                 |
                                                 v
                                       { keys: [{kty, n, e, kid, ...}] }
            |
            | (3) Charon verifies signature + iss + aud + exp
            |     Checks scope, tenant, runs the use case
            v
[Charon returns the result to the caller]
```

The caller can be the org's backend, the org's CLI tool, a CI
pipeline, a cron job — anything that holds the app credentials
in its environment. The Charon side never sees the app secret.

## 2. Why this is better than the previous design

| Concern | App secret on every request | Client credentials + JWT |
|---|---|---|
| Secret in logs | Yes — every request header | No — only at mint time |
| Secret rotation | Restart Charon + every caller | Rotate at Cerberus, callers pick up new key on next mint |
| Token expiry | None — secret is forever | 15 min default; auto-refresh |
| Multi-app | Manual — different secret per app | One Cerberus App per caller, isolated |
| Replay | No protection | 15 min window; Cerberus can also add jti-denylist for known-leaked tokens |
| Industry standard | ✗ (proprietary) | ✓ (RFC 6749 §4.4) |

## 3. What this requires on the Cerberus side

Cerberus V1.5 currently supports only `password` and
`refresh_token` grants (verified at
`src/authorization/interfaces/http/dto/token-request.dto.ts:15`:
`@IsIn(['password', 'refresh_token'])`). **The
`client_credentials` grant is not implemented.** This is the
single blocker for the pattern the user described.

### 3.1 What Cerberus needs to add

A new bounded-context use-case:

**`IssueClientCredentialsAccessTokenUseCase`** in
`src/authorization/application/use-cases/`. The flow:

1. Receive `client_id` + `client_secret` from the
   `/v1/oauth/token` request body.
2. Look up the App via the `AppApiKey` table (find the row
   matching the **hashed** `client_secret` — the plaintext
   is one-way-only).
3. Verify the App is not revoked (`App.revokedAt IS NULL`).
4. Resolve the App's `defaultOrgSlug` → Organization
   (the `tenantId` of the resulting principal).
5. Mint an access token where:
   - `sub` = the App's UUID (a service principal, not a user)
   - `org` = the App's resolved Organization
   - `role` = `null` (apps don't have org roles; they have
     scopes)
   - `scope` = the intersection of (caller-requested scope)
     and (App's allowed scopes)
6. Sign with the current signing key.
7. Return `{ access_token, token_type: "Bearer", expires_in,
   scope }`.

The `client_credentials` grant is **the only grant that
authenticates the App itself, not a user**. There's no
refresh token (the app re-mints when needed), no session
(apps don't have sessions), and no MFA (apps don't have
phones).

### 3.2 Per-app scope allowlist

Today the `App` model has `defaultOrgSlug` but no
`allowedScopes` field. To make the OAuth2 scope-downgrade
rule work, every App needs a list of scopes it's allowed to
request. Proposed schema:

```prisma
model App {
  // ... existing columns ...
  /// Comma-separated list of OAuth2 scopes the app is allowed
  /// to request via the client_credentials grant. Empty list =
  /// no scopes (the app can authenticate but cannot do
  /// anything — useful for the "soft-revoked" admin case).
  /// Default populated at registration with a sensible V1
  /// minimum; operator can adjust via the admin API.
  allowedScopes String @default("") @db.VarChar(1024)
}
```

A V1 default for new apps: `payments:read escrows:read` —
the read-only minimum. The operator upgrades by PATCHing
`allowedScopes` through the admin API.

For Charon's V1, the `charon` register flow would set
`allowedScopes` to `payments:read payments:write
escrows:read escrows:write` — the full set of Charon
operations.

### 3.3 App-bound principal in the JWT

The current JWT has claims `sub`, `org`, `role`, `scope`,
`exp`. For an app-bound token:

- `sub` = the App's UUID
- `org` = the App's resolved Organization (UUID, not slug)
- `role` = `null`
- `scope` = the granted scopes
- `exp` = the standard expiry

Charon distinguishes user-bound from app-bound by:

- `role === null` AND `sub` matches a Cerberus App ID (lookup
  via cached `apps_by_id` map, refreshed every 5 min) →
  app-bound
- otherwise → user-bound

**Open question for the user:** should there be a separate
claim like `typ: 'app' | 'user'` to make this explicit, or
is the `role === null` heuristic good enough? Recommendation:
**add a `typ` claim**. Costs one line in the JWT signer,
saves every resource server from carrying the apps-by-id
cache.

### 3.4 What the Cerberus OpenAPI spec needs to say

`openapi.yaml` currently lists the `/v1/oauth/token`
endpoint with `grant_type: [password, refresh_token]`. Add
`client_credentials`. The schema for the request body needs
`client_id` and `client_secret` as optional fields. The
response is the same shape as the existing grants minus
`refresh_token` (apps re-mint, no refresh).

## 4. What this requires on the Charon side

### 4.1 New `CerberusClient` (the token-minter)

A small class in `src/interface/security/cerberus-client.ts`
that the Charon **composition root** holds (one instance per
process, not per request). It does:

1. Hold `client_id` + `client_secret` from env
   (`CERBERUS_CLIENT_ID` + `CERBERUS_CLIENT_SECRET`).
2. Lazy-mint a token on first use: `POST
   {CERBERUS_BASE_URL}/v1/oauth/token` with
   `grant_type=client_credentials`, `scope=...`.
3. Cache the token + its `expires_at` (computed from
   `expires_in` minus a 60s safety margin).
4. Return the cached token until ~60s before expiry.
5. On `401` from Cerberus (token revoked, signing key
   rotated and old key rejected, etc.), invalidate the
   cache and re-mint.

This is a **single-flight per process** — every internal
call in Charon reuses the same token. The cache key is
`(client_id, scope)`, so a Charon process that needs
different scopes for different operations can mint
multiple tokens.

### 4.2 When does Charon call Cerberus?

Not for normal user-driven requests (the user has their own
JWT, Charon validates via JWKS). Charon calls Cerberus for:

| Use case | Direction | Frequency | Notes |
|---|---|---|---|
| Token-mint at startup | Charon → Cerberus | Once per process | One token, cached |
| Audit-log push | Charon → Cerberus | Per destructive op (refund, release, dispute) | Outbound webhook surface needed on Cerberus |
| User profile lookup (optional) | Charon → Cerberus | Per request (cached) | For richer error messages only |
| Token revocation (admin) | Charon → Cerberus | On operator action | Via Cerberus admin API |

The first one is the only one the user explicitly asked for
in this turn. The other three are deferred to V2 unless a
real need surfaces.

### 4.3 What Charon does NOT need to change

- **JWKS validation is still the primary auth path.** Every
  Charon endpoint that takes a Bearer JWT validates it
  against the cached JWKS. The JWKS validator doesn't know
  or care whether the JWT was minted via `password`,
  `refresh_token`, or `client_credentials` — all three mint
  the same kind of token.
- **The Principal value object is unchanged.** Same fields
  (`userId`, `organizationId`, `role`, `scopes`,
  `expiresAt`). The `typ` claim is a hint, not a separate
  field.
- **The use cases don't change.** A payment intent is a
  payment intent regardless of whether the caller is a human
  or an app. The `tenantId` check is the same.

### 4.4 What Charon DOES need to add

Three things, all in `src/interface/security/`:

1. **`CerberusClient`** — the token-mint client (4.1 above).
   Used by the composition root to authenticate Charon as
   an outbound caller of Cerberus.

2. **`JwksClient`** — fetches and caches the JWKS from
   `/.well-known/jwks.json` (5-min TTL, kid-based key
   resolution). Used by the inbound `CerberusAuthGuard`.

3. **`CerberusAuthGuard`** — the inbound guard. Verifies
   Bearer JWT, builds `Principal`, checks `@Scopes(...)`,
   attaches to `req.user`. Mirrors Cerberus's own
   `JwtAuthGuard` (`cerberus/src/authorization/interfaces/
   security/jwt-auth.guard.ts:48-134`).

No changes to the use cases. No changes to the aggregates.
No changes to the repository layer. The auth wiring is
purely a new layer in `src/interface/`.

## 5. Concrete wire shape

### 5.1 The org's perspective (in their env / k8s secret)

```bash
# .env for an org that wants to use Charon for payments
CERBERUS_BASE_URL=https://auth.example.com
CERBERUS_CLIENT_ID=8b3f4a7c-...
CERBERUS_CLIENT_SECRET=43char-base64url-plaintext-key
CHARON_BASE_URL=https://charon.example.com
```

Their service does:

```ts
// Step 1: mint a token (cached internally; for clarity, shown
// unrolled here)
const tokenResp = await fetch(`${CERBERUS_BASE_URL}/v1/oauth/token`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams({
    grant_type: 'client_credentials',
    client_id: process.env.CERBERUS_CLIENT_ID,
    client_secret: process.env.CERBERUS_CLIENT_SECRET,
    scope: 'payments:write escrows:write',
  }),
});
const { access_token } = await tokenResp.json();

// Step 2: call Charon
const paymentResp = await fetch(`${CHARON_BASE_URL}/v1/payments`, {
  method: 'POST',
  headers: {
    'Authorization': `Bearer ${access_token}`,
    'Content-Type': 'application/json',
  },
  body: JSON.stringify({ amount: 10000, currency: 'USD', ... }),
});
```

### 5.2 Charon's perspective (server side)

The org sends `Authorization: Bearer *** to Charon. Charon's
`CerberusAuthGuard`:

1. Extract the Bearer token.
2. Fetch JWKS from `${CERBERUS_BASE_URL}/.well-known/jwks.json`
   (cached 5 min, kid-indexed).
3. Verify signature, `iss`, `aud`, `exp`.
4. Build `Principal` from claims:
   - `userId` = `sub` (UUID — for app-bound, this is the App
     UUID; for user-bound, the User UUID)
   - `tenantId` = lookup `org` slug → Organization UUID
     (one DB call, cached)
   - `role` = `role` claim or `null` for apps
   - `scopes` = parse `scope` claim
   - `typ` = `typ` claim or infer (`role === null` +
     `org` non-null → `app`)
5. Check `@Scopes('payments:write')` — if missing, 401
   `insufficient_scope`.
6. Attach as `req.principal`.
7. Controller reads `@CurrentPrincipal()` and passes
   `principal.tenantId` into the use case.
8. Use case loads aggregate, checks
   `aggregate.tenantId === principal.tenantId`, throws
   `TenantMismatchError` (renders 404) if not.

## 6. The revised charon roadmap (incorporating this)

The previous roadmap (PR-NN1 through PR-NN4) is unchanged in
shape. The Cerberus-side prerequisites become a new mini-PR
in the Cerberus repo, before any of the charon HTTP work
begins:

### Cerberus-PR-1 — Client Credentials grant (3-5 days)

Files:
- `src/authorization/application/use-cases/issue-client-credentials-access-token.use-case.ts`
- `src/authorization/interfaces/http/oauth.controller.ts` —
  add the `client_credentials` branch
- `src/authorization/interfaces/http/dto/token-request.dto.ts`
  — add `client_id`, `client_secret`, `client_credentials`
  to the `grant_type` enum
- `prisma/schema.prisma` + migration — add
  `App.allowedScopes` column
- `src/apps/application/use-cases/rotate-app-key.use-case.ts`
  — keep the existing key, also include the new field
- New test: `issue-client-credentials.use-case.spec.ts`
  (scope downgrade, revoked app, unknown client_id)
- New e2e: `oauth.client-credentials.e2e-spec.ts` (full
  round-trip)
- `openapi.yaml` — document the new grant

### Charon-PR-NN1 — Tenancy data model + tenant ownership checks

Unchanged. The data-model work doesn't depend on auth.

### Charon-PR-NN2 — HTTP layer + JWT verification + CerberusClient

Unchanged in shape, but now includes the
`CerberusClient` (the token-minter for outbound calls). This
client is **only** used by Charon when it itself needs to
call Cerberus (e.g. for audit-log push). For the inbound
direction, Charon only validates JWTs via JWKS — it does
not mint tokens on behalf of its callers.

### Charon-PR-NN3 — First outbound gateway adapter

Unchanged. Uses the verified principal's tenant + scopes
from the inbound request to populate the gateway call.

### Charon-PR-NN4 — Webhook inbox writer

Unchanged. Public endpoints with provider HMAC.

## 7. Open questions for the user (decide before Cerberus-PR-1)

1. **`typ` claim in the JWT.** Add `typ: 'user' | 'app'`
   to every token, or rely on the `role === null` + App
   lookup heuristic? Recommendation: add `typ`. One line in
   the JWT signer; saves every resource server from
   carrying the apps-by-id cache.

2. **`allowedScopes` default for new apps.** What does a
   freshly-registered app get? Recommendation: empty list
   (`""`) — operator must explicitly grant scopes. Safer
   than a permissive default. The registration endpoint
   could accept an optional `initialScopes` parameter
   that the operator pre-approves.

3. **App secret rotation on Cerberus side.** When the
   operator rotates the key, does the old key stay valid
   for a grace period (like JWT signing keys: 7 days),
   or is rotation immediate? Recommendation: 24-hour
   grace period. Mirrors the API key rotation UX users
   already expect from cloud providers (AWS, Stripe).

4. **`POST /v1/oauth/token` — keep `password` grant?** It
   is RFC-discouraged for third-party apps (RFC 6749 §4.3).
   Cerberus's V1 code has it for "first-party" use, but
   once client_credentials lands, password grant should
   be deprecated. Recommendation: deprecate the password
   grant in the OpenAPI doc, keep the code path for
   backward compat, remove in V2.

5. **Audit log on Cerberus side.** When Charon mints a
   token via client_credentials, Cerberus should record
   `app.token.issued` in the audit log. Already
   supported by the existing `RecordAuditEventUseCase`.
   Just wire it. Recommendation: yes, ship it in
   Cerberus-PR-1.

## 8. What I am NOT going to do without the user

This is a plan. No code to either repo. The earlier
integration doc at
`docs/audits/2026-10-17-cerberus-integration-plan.md` and
this addendum are both staged in the charon repo (untracked)
for your review.

The next action is the user picking the answers to the five
open questions in §7, then I start on Cerberus-PR-1 (the
`client_credentials` grant) since it blocks everything
else. After Cerberus-PR-1 lands, the charon work follows
the existing roadmap.
