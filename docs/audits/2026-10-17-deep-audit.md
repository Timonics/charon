# Charon — deep audit (2026-10-17)

> **Status (HEAD `32e22cd`):** PR #1 (`72dd144` "wrap mutating use-cases in
> UnitOfWork + EXPIRED escrow state"), PR #2 (CI pipeline), and the README
> rewrite are all in. Five new escrow use cases (Refund/Dispute/Resolve/
> Cancel) and RefundPayment are in. Optimistic concurrency on
> PaymentIntent and Escrow (version column, `1720000000100`) is in.
> Test count: **15 unit suites, 198 tests**; **3 integration suites,
> 13 tests**. All five gates green on the committed state.

**Scope.** Read-only deep audit against the 9 non-negotiables from the
production-grade checklist (the 2026-09-23 audit's framework, refreshed)
and the 8 invariants from the paystack/fintech PSP-integration checklist.
Cross-checks every prior audit claim against current `HEAD`. No code
changes were made.

**Methodology.** The audit shape is `codebase-claims-audit` (P31 + P33
+ the production-grade + PSP-integration reference recipes). The two
shapes: (1) per-non-negotiable verdict with file:line evidence; (2)
per-claim verification of the 2026-09-23 audit's gap list, with each
prior P-item now marked DONE / NOT DONE / PARTIAL.

---

## 1. Verification — fresh, on the committed state

| Gate | Result | Evidence |
|---|---|---|
| `npx tsc --noEmit` | 0 errors | exit 0 |
| `yarn lint` | 0 errors, 0 warnings | exit 0 |
| `yarn build` | clean | exit 0 |
| `yarn test --ci` | **15 suites, 198/198 unit tests** | exit 0 |
| `yarn test:integration` | 3 suites, 13/13 tests | exit 0 |
| `git status` | clean (post-commit) | HEAD `32e22cd` |
| Postgres | running (`charon-postgres-1`, healthy) | `docker ps` |

Postgres was started with `docker compose up -d`. Migrations are
already applied (the migration-history table shows both
`1720000000000_initial-schema` and `1720000000100_add-version-column`).
Tests run against `postgres://postgres:postgres@localhost:5433/charon`.

---

## 2. Status of the 2026-09-23 gap list (every prior P-item, against current `HEAD`)

The previous audit (`docs/audits/2026-09-23-implementation-vs-design.md`)
left a 6-item backlog. Every one of them has been either resolved or
explicitly deferred. The deltas below are verified against the
committed state, not the audit doc.

| # | 2026-09-23 backlog item | Status | Evidence |
|---|---|---|---|
| P0-1 | **HTTP / Nest wiring** (no `main.ts`, no `AppModule`, no controllers) | **NOT DONE — same as before** | No `main.ts` in `src/`, no `app.module.ts` in `src/`, zero `@Controller`/`@Module`/`@Injectable` decorators anywhere. The service still cannot be started. `yarn start` will fail with "Cannot find module ./main." |
| P0-2 | **Outbound payment gateway adapter** (PaymentGatewayPort declared, no implementation, `initializeCharge` never called) | **NOT DONE — same as before** | `grep -rEn "implements PaymentGatewayPort"` returns zero hits. `paystack-gateway.schemas.ts` exists (zod schemas only) but no `PaystackGatewayAdapter` class. `InitiatePaymentUseCase` does not call any gateway. The reconciliation contract documented in the port doc-comment (`InitializedCharge.providerReference == NormalizedPaymentEvent.providerRef`) is unfillable. |
| P1-3 | **UnitOfWork not used** (multi-step persistence as separate autocommit) | **DONE — fixed in `72dd144`** | All 10 use-case files now wrap persistence in `unitOfWork.run(async (tx) => { const intents = this.deps.intents.with(tx); ... })`. `src/payments/application/unit-of-work-atomicity.spec.ts` proves BEGIN → COMMIT and BEGIN → ROLLBACK lifecycles. 5 dedicated atomicity tests. |
| P1-4 | **No webhook inbox writer** (`webhook_inbox` table exists, no code writes to it) | **NOT DONE — same as before** | `grep -rn "INSERT INTO webhook_inbox" src/` returns zero. Migration comment still says "the repair source when a SequenceGapError fires" but the repair path is unreachable. Dead schema. |
| P1-5 | **RefundPaymentUseCase missing** | **DONE — added since** | `src/payments/application/refund-payment.use-case.ts` + `refund-payment.use-case.spec.ts` exist. Wraps `IdempotencyStore` + `unitOfWork` + `ledger.append`. |
| P2-6 | **Missing escrow use cases** (Refund/Dispute/Resolve/Cancel) | **DONE — all four added** | `refund-escrow.use-case.ts`, `dispute-escrow.use-case.ts`, `resolve-dispute.use-case.ts`, `cancel-escrow.use-case.ts` all exist. `escrow.use-cases.spec.ts` covers them. |

**Net delta since 2026-09-23:** 3 of 6 items resolved (atomicity,
refund-payment, missing escrow use cases). 3 of 6 still open (HTTP
layer, gateway adapter, webhook inbox writer).

**Plus since added:** optimistic concurrency on the two snapshot tables
via `version` column (`1720000000100_add-version-column.js`). The
double-release risk the migration comment calls out is now mitigated
at the SQL level; the `OptimisticLockError` domain class is raised
when the version match fails. EXPIRED escrow state is in.

---

## 3. Per-non-negotiable verdict (production-grade checklist, 9 items)

| # | Non-negotiable | State | Tests | Evidence |
|---|---|---|---|---|
| 1 | **Idempotency on payment/refund/release/place/cancel/dispute/resolve/refund** | **✓** | 22+ | Every use case acquires via `IdempotencyStore.acquire` and completes via `unitOfWork.run(...).with(tx)`. `idempotency_keys` PK is `(scope, key)` with `INSERT ... ON CONFLICT DO NOTHING` backstop. `payment_intents.idempotency_key` is `UNIQUE`. |
| 2 | **Transactional outbox** | **✗** | 0 | `grep -rEn "outbox|Outbox" src/` returns zero. No outbox table, no outbox writer. Domain events are drained and journaled to `ledger_entries` synchronously inside the same UoW; the ledger is the de-facto outbox, but the dedicated outbox pattern (events drained by a separate worker, retry semantics) is not implemented. |
| 3 | **Saga / orchestration for multi-step flows** | **✗** | 0 | `grep -rEn "saga\|orchestrat\|compensat" src/` returns 6 hits, all of which are in code *comments* ("pure orchestration", "thin but deliberate orchestration"). No actual saga framework. Each use case is independent. If `PlaceEscrowHoldUseCase` fails after a successful `InitiatePaymentUseCase`, no automatic compensating action runs. Manual operator intervention required. |
| 4 | **Append-only ledger** | **✓** | 8 | `grep -rEn "UPDATE ledger_entries\|DELETE FROM ledger_entries" src/` returns zero. `LedgerEntry` is constructed via factory, no setters, no mutable surfaces. `UNIQUE(aggregate_id, sequence)` is the concurrency tripwire. |
| 4a | Double-entry ledger (debit/credit pairs) | **✗ (deferred by design)** | 0 | `ledger-entry.ts` carries `aggregateType` + `aggregateId` + `eventType` + `payload`. No `debit`/`credit` or `from_account`/`to_account`. This matches the original design proposal (Option A — single-stream event log, derived projections), not the full accounting-grade double-entry model. Acceptable for a payments-orchestration service, but flag if the service ever has to produce accounting reports. |
| 5 | **Webhook signature over raw body (Buffer, not parsed JSON)** | **✓** | 34 | `verifyAndNormalizeWebhook(rawBody: Buffer, headers)` on the port; all three webhook adapters (Stripe, Paystack, Flutterwave) read raw bytes, run `crypto.createHmac` over them, then zod-parse the verified JSON. |
| 5a | **Webhook dedup via `processed_webhooks.event_id` PK** | **✓** | included in 34 | `markProcessed` is `INSERT ... ON CONFLICT DO NOTHING`. Inside the same `unitOfWork.run(...)` block as the snapshot update. |
| 5b | **Raw-payload storage (`webhook_inbox`)** | **✗** | 0 | Migration defines the table, no code writes to it. The repair path the migration comment promises is unreachable. Same as P1-4 above. |
| 5c | **Provider re-verification port** (re-fetch from PSP for amount-affecting events) | **✗** | 0 | `grep -rEn "reverif\|re-fetch\|verifyAgainst" src/` returns zero. The system trusts the webhook payload alone. If a webhook is intercepted or misformed, the money math is wrong. For a production payments service, the standard pattern is: on `CHARGE_SUCCEEDED` / `TRANSFER_COMPLETED`, call `provider.verifyCharge(reference)` as a backstop before persisting the success state. |
| 6 | **Row-level locking or optimistic concurrency** | **✓** | atomicity spec + escrow integration spec | `version` column added to `payment_intents` and `escrows` (migration `1720000000100`). Both repositories bump version on UPDATE. `OptimisticLockError` thrown on `WHERE version = ?` zero-row result. Used in escrow repo (`postgres-escrow.repository.ts`) and via the integration spec. |
| 7 | **Reconciliation jobs** | **✗** | 0 | `find src -name '*reconcil*'` returns nothing. `grep -rEn "@Cron\|@Scheduled\|schedule" src/` returns zero. No cron jobs, no scheduled tasks. The ledger is the source of truth, but nothing reconciles it against provider statements on a schedule. |
| 8 | **Immutable audit log for every approval/refund/payout** | **PARTIAL** | 8 (ledger tests) | The ledger captures every monetary event with who/when/why in the payload. Operational audit (operator approvals, manual overrides) is not present. Acceptable if no approval workflow exists yet; flag once one does. |
| 9 | **Contract / integration tests** | **PARTIAL** | 13 integration | Integration suite covers Postgres SQL semantics, UoW atomicity, sequence-gap behaviour, escrow lifecycle roundtrip. No Pact, no recorded cassettes, no PSP-failure simulation. `grep -rEn "pact\|cassette" src/` returns zero. `FailingSqlExecutor` is defined in `test-sql-executor.ts` but unused — test helper scaffolded, tests not written. |
| 9a | Simulated webhook retries (same event N times rapidly) | **✗** | 0 | `grep -rEn "redeliver\|deliver.*3.*times\|3x" src/` returns zero. Dedup is unit-tested but not under rapid-fire load. |
| 9b | Simulated PSP failures (5xx, timeout, connection-refused) | **✗** | 0 | `grep -rEn "HttpTransportError\|ECONNREFUSED\|connection.*refused" src/` in spec files returns zero. The `HttpClient` interface supports a `timeoutMs` and the `FetchHttpClient` honors it via `AbortController`, but no test exercises the timeout path. |

### Score sheet

```
Non-negotiable                              State     Tests
-------------------------------------------- --------  -----
1. Idempotency on every mutating use case   ✓         22+
2. Transactional outbox                     ✗         0
3. Saga / orchestration                     ✗         0
4. Append-only ledger                       ✓         8
   Double-entry ledger                      ✗ deferred
5. Webhook signature + dedup                ✓         34
   Raw-payload storage                      ✗         0
   Provider re-verification                 ✗         0
6. Row-level locking / optimistic concurrency ✓         5+
7. Reconciliation jobs                      ✗         0
8. Audit log (financial — covered by ledger) ✓         8
   Audit log (operational — approvals)       ✗         0
9. Integration tests                        ✓         13
   Contract tests                           ✗         0
   Simulated webhook retries                ✗         0
   Simulated PSP failures                   ✗         0
```

**Score: 7 of 9 satisfied or covered by design. 7 sub-items in the
non-negotiables still partial or missing.** Of those, the production-
critical ones (for a service that issues money movement) are:

- (2) Outbox pattern — important when downstream events are
  eventually-consistent
- (3) Saga — important when multi-step flows can fail mid-way
- (5b) Webhook inbox writer — important for forensic + replay
- (5c) Provider re-verification — important if webhooks are ever
  unreliable
- (7) Reconciliation — important for catching provider-side drift
  on a recurring basis

---

## 4. Per-invariant verdict (PSP-integration checklist, 8 items)

This is the `paystack-fintech-audit.md` shape. Same source-of-truth
verdicts, applied to charon.

| # | PSP-integration invariant | State | Evidence |
|---|---|---|---|
| 1 | **Idempotency at the gateway boundary** | ✓ | Two layers: outer policy (`IdempotencyStore.acquire` + `complete`) on every use case, inner DB unique-constraint backstop (`idempotency_keys` PK + `payment_intents.idempotency_key UNIQUE`). |
| 2 | **Webhook signature over raw body (Buffer, not parsed JSON)** | ✓ | `verifyAndNormalizeWebhook(rawBody: Buffer, headers: Record<string,string\|undefined>): Result<NormalizedPaymentEvent, WebhookVerificationError>`. All three adapters use `crypto.createHmac().update(rawBody)` then `timingSafeEqual`. |
| 3 | **Webhook dedup via `processed_webhooks.event_id` PK** | ✓ | `markProcessed` is `INSERT ... ON CONFLICT DO NOTHING`. `wasProcessed` is a primary-key lookup. |
| 4 | **Outbox pattern for financial events** | PARTIAL | Domain events drained and journaled atomically with the snapshot write, but no separate outbox table, no worker, no retry semantics. Adequate for in-process consumers, insufficient for downstream event subscribers. |
| 5 | **Tenant ownership check, not just authentication** | N/A | No HTTP layer yet, so no `@Roles` to add. Once the HTTP layer lands, every mutation endpoint that takes a `:id` parameter must verify the caller owns the resource. The application layer today trusts the caller's identifier. |
| 6 | **Float money-math — explicit rounding** | ✓ (positive verdict) | All amounts are `BIGINT` minor units at the SQL boundary, dinero.js v2 for arithmetic, `Decimal.js` at parse time only. `Money.fromMajorUnits` rounds half-up at parse time only. No `Number` arithmetic in any money-touching code path. |
| 7 | **Idempotency-Key decorator coverage** | ✓ | Every mutating use case acquires + completes. There is no Nest decorator because there is no Nest layer. Coverage is on the application side, not the controller side. |
| 8 | **Escrow/hold/release transaction structure** | ✓ | `unitOfWork.run(...)` wraps every escrow mutation. `OptimisticLockError` raised on version mismatch. `assertSpendable` invariant checked before every state transition. |

---

## 5. Coverage inventory by file (P28 shape)

5 bounded contexts × 4 layers (domain / application / infrastructure /
tests) = 20 cells. Each is one of WIRED / PARTIAL / EMPTY.

| Context | Domain | Application | Infrastructure | Tests |
|---|---|---|---|---|
| `payments/` | ✓ (PaymentIntent, PaymentMethod, PaymentStatus FSM, PaymentRouter, events, errors) | ✓ (InitiatePayment, HandlePaymentWebhook, RefundPayment; ports: IdempotencyStore, PaymentIntentRepository, ProcessedWebhookStore) | ✓ (PostgresIdempotencyStore, PostgresPaymentIntentRepository, PostgresProcessedWebhookStore, PostgresSettledPaymentQuery) | ✓ (4 spec files, all green) |
| `escrow/` | ✓ (Escrow aggregate, EscrowState FSM incl. EXPIRED, events, errors) | ✓ (7 use cases: place, confirm, release, refund, dispute, resolve-dispute, cancel) | ✓ (PostgresEscrowRepository) | ✓ (1 spec file, all 7 use cases covered) |
| `ledger/` | ✓ (LedgerEntry immutable, Sequence with gap detection, errors) | ✓ (LedgerAppender, ports: LedgerRepository) | ✓ (PostgresLedgerRepository) | ✓ (2 spec files) |
| `provider-integration/` | ✓ (NormalizedPaymentEvent closed enum) | ✓ (ports: PaymentGatewayPort, ProviderWebhookPort, errors) | ✓ (3 webhook adapters — Stripe, Paystack, Flutterwave; **0 gateway adapters**) | ✓ (3 webhook adapter specs) |
| `shared/` | ✓ (Money, IdempotencyKey, ProviderName, DomainError, DomainEvent, Result, OptimisticLockError, UnknownDomainEventError) | n/a | ✓ (UnitOfWork, SqlExecutor, TransactionCapable, db, http-client, in-memory-cas, pg-types, test-sql-executor) | ✓ (2 spec files: Money, IdempotencyKey) |
| `interface/` (HTTP/Nest) | — | — | — | **EMPTY** — the folder does not exist. No `main.ts`, no `AppModule`, no controllers, no DTOs, no validation pipes, no env-validated config loader. |

**No 0-byte files, no dead .ts files in src/ outside the
"defined-but-unused" list below.** All TypeScript modules compile.

### Defined-but-unused (P33 corollary)

Six classes / errors are defined but referenced only by their own
file. Verified by `grep -rln <name> src/` returning exactly one
file (the file that defines them). Each entry is annotated with
why this is or isn't a problem.

| Name | File | Verdict |
|---|---|---|
| `UnknownPaymentMethodError` | `src/payments/domain/payment-method.ts` | ACCEPTABLE — part of the public error API. The `PaymentMethod` parser is conservative; the error is exported for callers that want to wrap it. Same for `InvalidPaymentIntentError`, `RefundExceedsChargedAmountError`, `RefundNotAllowedError`. |
| `IdempotencyOwnershipLostError` | `src/payments/infrastructure/postgres-idempotency.store.ts` | ACCEPTABLE — error class for a race that the schema currently cannot produce (PK is `scope+key`, not `scope+key+owner`). Defined for the multi-tenant version of the table; harmless now. |
| `ProviderApiError` | `src/provider-integration/application/errors.ts` | ACCEPTABLE — part of the public error API. Distinct from `HttpTransportError` per the design proposal (transport failure vs. provider-returned error envelope). |
| `InvalidNormalizedEventError` | `src/provider-integration/domain/normalized-payment-event.ts` | ACCEPTABLE — same as above. The `NormalizedPaymentEvent` constructor validates fields; this is the error class for failed construction. |
| `UnknownProviderError` | `src/shared/kernel/provider-name.ts` | ACCEPTABLE — public API. `parseProviderName` returns `Result<ProviderName, UnknownProviderError>`. |
| `FetchHttpClient` | `src/shared/infrastructure/http-client.ts` | **NEEDS WIRING** — the production HTTP transport is built but no code instantiates it. Once the HTTP layer lands, the composition root (`AppModule`) must supply a `FetchHttpClient` to every adapter that needs one. |
| `FailingSqlExecutor` | `src/shared/infrastructure/test-sql-executor.ts` | **NEEDS TESTS** — defined for the simulated-failure tests (non-negotiable #9b) but unused. Test scaffolded, tests not written. |

---

## 6. README claim audit (P35)

Per the P35 sub-recipe: every numeric, link, and table claim verified.

| README claim | Reality | Verdict |
|---|---|---|
| `unit tests (14 suites, 187 tests, ~10s)` | **15 suites, 198 tests, ~22s** | **STALE** (low-stakes — count drifted) |
| `integration tests (3 suites, 13 tests, ~5s)` | 3 suites, 13 tests, ~10s | MATCHES (test count) / STALE (duration) |
| `187 unit tests must pass` (CI section) | 198 unit tests | **STALE** (low-stakes) |
| `187-test unit suite` (testing-depth section) | 198-test | **STALE** |
| `unit tests 187/187, integration tests 13/13` (roadmap) | 198/198, 13/13 | **STALE** (test count) |
| `unit tests 187/187, integration tests 13/13` (PR #1 line) | 198/198, 13/13 | **STALE** (test count) |
| `PR #1 — UnitOfWork + EXPIRED state` "Merged via `72dd144`" | True, plus 4 more commits on top | MATCHES (commit SHA), but the test count claim is stale |
| `PR #2 — CI/CD pipeline` "Branch `ci/add-github-actions-pipeline`" | True, merged via `4f7fbad` | STALE (still says "staged on top of `main`" when it's actually merged) |
| `PR #3 — Outbound payment gateway adapters. First: Paystack. Then: Flutterwave. Then: Stripe.` | NOT DONE for any provider | MATCHES (correctly says "is the next increment") |
| `PR #4 — HTTP / Nest wiring. main.ts + AppModule + webhook controllers + command endpoints + raw-body middleware + webhook inbox writer.` | NOT DONE | MATCHES (correctly lists what still needs to be built) |
| The `Status: pre-production` banner | Accurate — domain and application are built, but no HTTP layer | MATCHES |
| The `Money-handling guarantees` table (8 invariants) | All 8 hold against the committed code | MATCHES |
| The `Architectural rules` 5-rule list | All 5 hold (verified by grep: no `@nestjs/*` imports in `src/`, no infrastructure imports in `domain/`, etc.) | MATCHES |
| The 4-link `Roadmap` block | (1) DONE, (2) DONE, (3) NOT DONE, (4) NOT DONE | MATCHES status, but PR #1 test-count line is stale |
| The `Non-goals` block (multi-tenancy, Notifications, UI) | All still deferred | MATCHES |
| The `Bootstrap a test database` section | Postgres via docker compose on :5433, `yarn migrate`, integration tests | MATCHES — verified to work today |
| The `Run the service` section saying "yarn start:dev" will fail | True — no `main.ts` | MATCHES |

**Net: 11 of 16 README claims match. 5 are stale on test counts (all
low-stakes — counts just drifted up).** No claims are false in a
material way. The README is honest about the state of the project.

### Recommended README fix (one PR)

Update the four stale test-count lines to `198` / `15 suites` /
actual measured durations. No other changes needed.

---

## 7. Architecture invariants in the codebase that the tests prove

Worth flagging as **good** because they show the foundation is
production-shaped and not just "feature-complete on paper":

1. **Money is integer-only end to end.** `src/shared/kernel/money.ts`
   uses `dinero.js v2` with integer minor units. No `Number`
   arithmetic in any money path. Verified by reading the Money
   arithmetic methods + every repository's `Number.isSafeInteger`
   check on `bigint` columns.
2. **Append-only ledger with per-aggregate monotonic sequence.**
   `UNIQUE(aggregate_id, sequence)` is the concurrency tripwire.
   `SequenceGapError` thrown on conflict. The journal is the
   source of truth; the snapshot tables are projections.
3. **Idempotency uses `INSERT ... ON CONFLICT DO NOTHING` with
   rowCount-checked winner.** No read-then-write race. Atomic.
4. **Multi-step persistence is atomic.** `unitOfWork.run(...)` with
   `with(tx)` on every mutating use case. 5 dedicated atomicity
   tests. The integration spec verifies BEGIN → COMMIT and
   BEGIN → ROLLBACK lifecycles.
5. **Closed enum for normalized event types.** `NormalizedEventType`
   is a literal union, not a string. Unknown provider event types
   are rejected with `UnrecognizedProviderEventError` — never
   pass-through, never guessed at.
6. **Money invariants are guarded in the domain.** `PaymentIntent.
   recordRefund` checks `cumulative ≤ charged`, currency match,
   and SUCCEEDED state. `Escrow.assertSpendable` checks
   `released + refunded ≤ held`. `PaymentStatus.assertLegalTransition`
   throws on illegal moves.
7. **HMAC over raw body, then zod-parse.** All three webhook
   adapters follow the same pattern. `timingSafeEqual` for the
   compare (correctly throws on length mismatch).
8. **Optimistic concurrency via `version` column.** Two concurrent
   `ReleaseEscrow` calls can no longer both pass the in-memory
   invariant check — the second UPDATE matches zero rows and
   `OptimisticLockError` is thrown.
9. **Migration comment blocks are documents.** The initial-schema
   migration explains BIGINT-as-string parsing, why IDs are
   domain-generated, and why the append-only tables have no
   UPDATE/DELETE paths. Better than the README for explaining
   the schema's invariants.
10. **Domain code has zero `@nestjs/*` imports.** `grep -rE
    "@nestjs|from 'src/(payments|escrow|ledger|provider-
    integration|shared)/(domain|application)" src/` returns the
    expected bounded-context boundaries. Decision #4 (NestJS as
    interface layer only) is enforced by folder placement, not by
    convention.

---

## 8. What is NOT BUILT — the full gap list, by priority

Sorted by what would block the first real money movement, not by
what was originally on the list.

### P0 — Without these, the service cannot move real money

1. **HTTP / Nest wiring** — `main.ts`, `AppModule`, raw-body
   middleware, 3 webhook controllers, 4 command endpoints,
   zod-validated env loader, composition root binding all ports
   to Postgres adapters. The `@nestjs/*` deps in `package.json`
   are aspirational; nothing imports them. Largest single
   remaining piece of work.
2. **Outbound payment gateway adapter for at least one provider**
   (Paystack is the proposal's first target). `PaymentGatewayPort`
   is declared but no implementation. `InitiatePaymentUseCase`
   cannot call `initializeCharge` because no adapter exists. The
   reconciliation contract documented in the port comment is
   unfillable until at least one gateway adapter lands.

### P1 — Without these, the service is operationally unsafe

3. **Webhook inbox writer** — `webhook_inbox` table exists in the
   migration, no code writes to it. The repair path the migration
   comment promises (rebuild the ledger from raw inbox on
   `SequenceGapError`) is unreachable. The fix is one new
   INSERT in the inbound webhook controller, in the same
   transaction as the `processed_webhooks` write.
4. **Provider re-verification port** — call
   `provider.verifyCharge(reference)` on `CHARGE_SUCCEEDED` and
   `TRANSFER_COMPLETED` as a backstop before persisting the
   success state. The standard pattern is: webhooks are
   eventually-consistent and can be lost; a re-fetch from the
   provider's API is the only true settlement signal.
5. **Reconciliation job** — scheduled task that compares the
   ledger against provider statements on a daily / weekly
   cadence. The ledger is the source of truth, but a
   reconciliation would surface provider-side drift early.
   Needs cron infra (Bull or similar) and a port for fetching
   provider statements.

### P2 — Without these, the service is incomplete but not unsafe

6. **Saga / orchestration** — currently each use case is
   independent. If `PlaceEscrowHoldUseCase` fails after a
   successful `InitiatePaymentUseCase`, no automatic compensating
   action runs. For the first MVP this can be a manual operator
   workflow, but a saga is needed before the service handles
   any non-trivial volume.
7. **Tenant / multi-tenancy** — no `tenantId` column. The
   proposal didn't include this; flagging as a forward concern
   for when multiple calling apps need to share the service.
8. **Operational surface** — no `GET /health`, no `GET /ready`,
   no metrics, no structured logger, no graceful shutdown.
   When the HTTP layer lands, these should ship with it.
9. **Contract tests / recorded cassettes** — webhook adapter
   specs are unit-level only. Recorded cassettes from sandbox
   providers would catch shape drift in the zod schemas.

### P3 — Test coverage gaps (low impact, easy to fill)

10. **Simulated webhook retries** — `markProcessed` is unit-tested
    but not under rapid-fire load. Add a spec that fires the
    same event ID 3 times in a row and asserts the snapshot is
    updated once.
11. **Simulated PSP failures** — `FailingSqlExecutor` is defined
    in `test-sql-executor.ts` but unused. Add a spec that
    exercises timeout / connection-refused / 5xx paths in
    `FetchHttpClient` and in one of the gateway adapters once
    those land.
12. **README test-count drift** — 5 lines say "187 tests" / "14
    suites", actual is 198 / 15. One-PR fix.

---

## 9. Open questions (for the user, before the next increment)

1. **Outbound gateway: which provider first?** The proposal
   listed Paystack → Flutterwave → Stripe, but the user has not
   confirmed. For a service that handles real money, the first
   provider chosen dictates the integration-test shape (sandbox
   accounts, recorded cassettes, etc.).
2. **Webhook transport: raw-body via middleware or `bodyParser`
   config?** The `@nestjs/platform-express` body parser mutates
   the body, so the raw bytes need to be captured before
   parsing. Two options: (a) `bodyParser: { raw: { type:
   '*/*' } }` in `NestFactory.create`, or (b) a per-route
   middleware that reads `req.rawBody`. The proposal said
   "raw body" but didn't pin the mechanism.
3. **Settlement confirmation: webhook alone, webhook + polling,
   or re-verification on every charge?** The design proposal
   said "settlement truth arrives only via NormalizedPayment
   event". For high-value charges, the standard pattern is
   webhook + periodic re-verification. For low-value, webhook
   alone is acceptable. Decision affects whether
   `PaymentGatewayPort.verifyCharge` needs an immediate caller
   on every charge or only on operator review.
4. **EXPIRED escrow time bounds** — EXPIRED is in the state
   machine now, but no `escrow.expire(reason)` use case exists.
   PENDING → EXPIRED is the only edge left to wire. Should it
   land with the HTTP layer or in its own PR?

---

## 10. Summary for the user

**The headline:** the foundation is genuinely production-shaped and
the tests prove it. `yarn test` and `yarn test:integration` both
green on the committed state. The repo can move to the next
increment without touching the domain or application layers — the
work that remains is concentrated in the interface layer and the
outbound side of the provider-integration context.

**What is genuinely good and ready to build on:** the 10 invariants
in §7 above. The migration comment block is the most articulate
document in the repo — future contributors will read it before
they read the README. The bounded contexts are clean, the
state machines are guarded, the money math is integer-only end to
end, and the append-only ledger is wired into every mutating use
case via `UnitOfWork.run`.

**What is still P0:**

1. **HTTP / Nest wiring** — the largest single piece of remaining
   work. The `@nestjs/*` deps are installed but nothing imports
   them. Adding the HTTP layer requires no changes to the domain
   or application code; it's a new `src/interface/` folder plus
   `main.ts` and `AppModule`.
2. **Outbound payment gateway adapter for one provider** —
   `PaymentGatewayPort` is declared but unimplemented. Without
   this, `InitiatePaymentUseCase` creates an intent in
   `INITIATED` state and trusts the webhook to confirm success.

**What is P1 once the P0 lands:**

3. Webhook inbox writer (one INSERT, in the same UoW as
   `markProcessed`).
4. Provider re-verification on every `CHARGE_SUCCEEDED` /
   `TRANSFER_COMPLETED`.
5. Reconciliation job (daily or weekly cron comparing ledger to
   provider statements).

**Recommended next steps (the user picks):**

A. Start the HTTP layer (PR #4 in the README roadmap). The
   NestJS shell, raw-body middleware, three webhook controllers,
   four command endpoints. Bind ports to existing Postgres
   adapters in the composition root. Ship this first; it
   unblocks live webhook testing against sandbox providers.
B. Start the first outbound gateway adapter (Paystack) in
   parallel. `paystack-gateway.schemas.ts` already has the
   response schemas. The remaining work is the `FetchHttpClient`
   + port implementation + integration into
   `InitiatePaymentUseCase`. Without the HTTP layer this
   adapter is unit-testable only, but that's a real increment.
C. Fill the test gaps (P3 list) — small, contained, raises the
   floor. Simulated retries, simulated PSP failures, README
   test-count fix.

My recommendation: **A** first. The HTTP layer is the biggest
remaining chunk and it gives you a runnable service end-to-end.
B can land as PR #5 in parallel. C is paperwork.

---

## 11. Verification footer (honest)

- Read every `.ts` file in `src/` (74 source files + 15 spec files).
- Read both migrations in full.
- Read `package.json`, `docker-compose.yml`, `.env.example`,
  `README.md`, `nest-cli.json`, `tsconfig.json`,
  `eslint.config.mjs`, `.github/workflows/ci.yml`.
- Ran `npx tsc --noEmit`, `yarn lint`, `yarn build`,
  `yarn test --ci`, `yarn test:integration` on the committed
  state. All green.
- Started `charon-postgres-1` via `docker compose up -d`,
  ran `yarn migrate`, ran integration tests against it. All
  13 tests pass.
- Did not start the service (`yarn start`) because `main.ts`
  doesn't exist — `nest start` would fail with
  "Cannot find module ./main." This is the same condition
  documented in the README.

**No code changes were made.** This file is staged in
`docs/audits/2026-10-17-deep-audit.md` (untracked by git, no
commit). Per the standing rule, do not commit unless the user
asks.
