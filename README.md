# charon

A payments orchestration service for multi-provider money movement:
charges, refunds, escrow holds, releases, refunds, and disputes —
across Stripe, Paystack, and Flutterwave — with a single append-only
ledger as the source of monetary truth.

This is the service that owns the **business state**. Money movement
happens at the providers; charon records what happened, when, and
why, in an auditable event stream that survives any single provider
being wrong, slow, or unavailable.

**Status: pre-production.** Domain and application layers are built
and unit-tested. Postgres infrastructure is built and
integration-tested against a real Postgres 16. HTTP/Nest wiring and
the outbound payment gateway adapters are not yet wired. See
[Roadmap](#roadmap) below. CI is wired on GitHub Actions (PR #2).

---

## What it does

A payment flows through charon like this:

```
                 ┌──────────────┐    ┌──────────────┐
                 │  payments    │    │  escrow      │
   caller  ───►  │  (intent,    │──►│  (hold,      │──►  ledger
                 │  webhook)    │    │  release)    │     (append-only)
                 └──────────────┘    └──────────────┘
                         │                  │
                         └──── provider-integration ────► Stripe / Paystack / Flutterwave
                                (webhook verification,
                                 outbound charge adapter)
```

- **Payments context** — the lifecycle of a single charge: `INITIATED`
  → `PROCESSING` → `SUCCEEDED | FAILED | EXPIRED`. Settlement truth
  comes from verified provider webhooks, never from the synchronous
  provider API response.
- **Escrow context** — holds over settled funds. Partial releases are
  first-class line entities from day one. Terminal states include
  `RELEASED`, `REFUNDED`, `CANCELLED`, and `EXPIRED`.
- **Ledger context** — every state change in payments or escrow appends
  an immutable event to the ledger. Per-aggregate monotonic sequence,
  unique-constraint backstop. Projections are rebuildable from the
  journal; the journal is the truth.
- **ProviderIntegration context** — adapter for each PSP's webhook
  signature scheme + closed-enum mapping to internal `NormalizedPaymentEvent`.

---

## Money-handling guarantees

These are the invariants the codebase enforces and the tests prove.
Anything that violates them must be caught by a test before it lands.

| # | Invariant | Enforced by |
|---|-----------|-------------|
| 1 | The sum of all charges and refunds is auditable from the ledger alone — no other table is needed to answer "what happened to this money?" | `LedgerEntry` is immutable, payload is JSON-validated at construction, journal is the source of truth |
| 2 | A payment's status only moves forward through the FSM. Terminal states (SUCCEEDED, FAILED, EXPIRED) are frozen forever. | `PaymentStatus.assertLegalTransition` |
| 3 | A webhook event id is processed at most once. A redelivery is a no-op. | `ProcessedWebhookStore.wasProcessed`/`markProcessed` + the already-in-target-state guard |
| 4 | An idempotency key is acquired at most once across concurrent callers. The second caller gets a typed error, not a duplicated side effect. | `IdempotencyStore.acquire` uses `INSERT ... ON CONFLICT DO NOTHING` with rowCount-checked winner |
| 5 | A refund can never exceed the charged amount. Cumulative refunds are bounded by the original charge. | `PaymentIntent.recordRefund` invariant check |
| 6 | An escrow's `released + refunded ≤ held` at all times, even mid-transaction. | `Escrow.assertSpendable` invariant check |
| 7 | Settlement only happens from a *verified* provider webhook, never from the synchronous API response. | `HandlePaymentWebhookUseCase` requires `event.type === CHARGE_SUCCEEDED` and signature verification upstream |
| 8 | Multi-step persistence is atomic. Intent snapshot + ledger append + idempotency complete all commit together or all roll back. | `UnitOfWork` wraps every mutating use case; 5 atomicity tests prove BEGIN → COMMIT or ROLLBACK lifecycle |

---

## Local development

### Prerequisites

- Node.js 22 (matches `.nvmrc`)
- Yarn 1.22+ (`npm install -g yarn`)
- Docker (for the local Postgres) — or any reachable Postgres 16 instance
- dinero.js v2 + decimal.js for the money math

### First-time setup

```bash
yarn install --frozen-lockfile
cp .env.example .env                 # adjust DATABASE_URL if your Postgres isn't on :5433
docker compose up -d postgres        # boots postgres:16-alpine on host port 5433
yarn migrate                        # applies migrations/1720000000000_initial-schema.js
```

### Run the tests

```bash
yarn test                           # unit tests (14 suites, 187 tests, ~10s)
yarn test:integration               # integration tests (3 suites, 13 tests, ~5s)
                                    # requires a live Postgres
yarn lint                           # eslint with the project's config
yarn build                          # nest build → dist/
```

### Run the service

```bash
yarn start:dev                       # nest start --watch
```

The HTTP layer is not yet implemented (see [Roadmap](#roadmap)). The
build succeeds; `yarn start` will fail with "Cannot find module
./main" until PR #4 lands.

---

## Project structure

```
src/
├── payments/
│   ├── application/                 # use cases + port interfaces
│   │   ├── initiate-payment.use-case.ts
│   │   ├── handle-payment-webhook.use-case.ts
│   │   └── ports/                   # IdempotencyStore, PaymentIntentRepository, etc.
│   ├── domain/                      # pure TS — PaymentIntent aggregate, FSM, events
│   └── infrastructure/              # Postgres adapters
├── escrow/
│   ├── application/
│   ├── domain/
│   └── infrastructure/
├── ledger/
│   ├── application/                 # LedgerAppender — context-independent journal
│   ├── domain/                      # LedgerEntry, sequence gap detection
│   └── infrastructure/
├── provider-integration/            # webhook adapters (Stripe, Paystack, Flutterwave)
│   ├── application/
│   │   ├── ports/                   # PaymentGatewayPort, ProviderWebhookPort
│   │   └── ...
│   └── infrastructure/
│       ├── paystack/
│       ├── stripe/
│       └── flutterwave/
└── shared/
    ├── kernel/                      # Money, IdempotencyKey, ProviderName, DomainError
    └── infrastructure/              # SqlExecutor, UnitOfWork, TransactionCapable

migrations/                          # node-pg-migrate SQL migrations
test/                                # jest integration setup + config
docs/audits/                         # implementation-vs-design audits
```

### Architectural rules the codebase enforces

1. **Domain code has no I/O.** The `domain/` folders import nothing
   from `infrastructure/` or `@nestjs/*`. Domain types are pure
   TypeScript with no decorators.
2. **Application code depends on ports, not adapters.** Use cases
   depend on `IdempotencyStore`, `PaymentIntentRepository`, etc. —
   never on `PostgresIdempotencyStore`.
3. **Infrastructure implements ports.** Each `infrastructure/postgres-*.ts`
   file is the only place a real `pg` query appears.
4. **The append-only ledger is the source of truth.** Aggregates'
   snapshot tables (`payment_intents`, `escrows`) are projections that
   *can* be rebuilt from the ledger. They exist for fast reads, not
   for correctness.
5. **NestJS is the interface layer only.** Domain and application
   layers have zero `@nestjs/*` imports. When the HTTP layer lands
   (PR #4), it will be a thin shell wrapping the use cases.

---

## CI

GitHub Actions runs on every push and PR (`.github/workflows/ci.yml`):

**`lint-and-unit`** — runs on every push:
- `yarn lint` — 0 errors required
- `yarn build` — clean TypeScript compilation
- `yarn test --ci` — 187 unit tests must pass

**`integration`** — runs on PRs and main:
- Spins up a `postgres:16-alpine` service container
- Runs migrations, then `yarn test:integration`
- 13 integration tests must pass against a real database

The integration job is the bar for money correctness. If the unit
tests pass but the integration tests fail, the PR is rejected.

---

## Testing depth

We hold ourselves to two bars:

**Bar B (current floor) — domain + application with in-memory fakes.**
The 187-test unit suite covers the FSM transitions, money invariants,
refund arithmetic, payment-state machine, webhook dedup, idempotency
acquire/complete/release lifecycle, and UnitOfWork transaction
atomicity. No Docker needed.

**Bar C (next increment) — integration against real Postgres.** The
13-test integration suite covers the SQL semantics: BIGINT-as-string
parsing, ON CONFLICT semantics, sequence-gap behavior, per-aggregate
sequence ordering, escrow lifecycle roundtrip. Requires Docker.

The audit document at `docs/audits/2026-09-23-implementation-vs-design.md`
tracks which invariants are tested at which level.

---

## Roadmap

The agreed next-increment backlog (post-audit, in priority order):

1. ~~**PR #1** — UnitOfWork transaction wrapping + EXPIRED escrow
   state.~~ **Merged via `72dd144`** (unit tests 187/187, integration
   tests 13/13).
2. **PR #2 — CI/CD pipeline.** Branch
   `ci/add-github-actions-pipeline` staged on top of `main`.
   Three commits: initial workflow + integration-spec
   `unitOfWork` fix (`4f7fbad`), npm-ci EUSAGE workaround
   (`2bed683`), yarn migration for platform-stable lockfile
   (`cdd1293`). Lint + build + unit + integration on every push/PR.
3. **PR #3 — Outbound payment gateway adapters.** First: Paystack.
   Then: Flutterwave. Then: Stripe. Each adapter implements
   `PaymentGatewayPort` and is integrated into `InitiatePaymentUseCase`.
4. **PR #4 — HTTP / Nest wiring.** `main.ts` + `AppModule` + webhook
   controllers + command endpoints + raw-body middleware + webhook
   inbox writer. Adds the `Dockerfile` so the CI scan pipeline can
   be extended with Trivy.

After PR #4 lands, the service is runnable end-to-end against sandbox
provider credentials.

---

## Non-goals

These are explicit so reviewers don't have to guess:

- **Multi-tenancy.** A `tenantId` column does not exist. If this
  service is ever called by multiple upstream apps, tenant scoping
  on intents and idempotency keys will need to land before that
  becomes safe.
- **Webhook outbound (Notifications context).** Outbound webhooks to
  the calling app are deferred. Today, callers poll for status.
- **Notifications queue.** No email / SMS / push integrations.
- **UI.** This is a backend service. The boss-facing surface is the
  ledger and the integration tests.

---

## License

UNLICENSED — proprietary, internal.
