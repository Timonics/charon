# Charon — implementation audit vs. design proposal (2026-09-23)

> **Status (PR #1 of 4):** UnitOfWork transaction wrapping is complete and
> proven by 5 atomicity tests against the production Postgres repos with a
> fake PoolClient. EXPIRED state added to the escrow FSM. Test count went
> from 179 → 187. Branch: `feature/chore/uow-transaction-wrapping`. Staged,
> no commit yet.

**Scope.** Read-only inventory of `C:\Users\Church\Mickey's Files\charon\` against the
five-context design proposal (Payments, Escrow, Ledger, ProviderIntegration,
deferred Notifications). Every claim below was verified by reading the source or
running a targeted grep. No code changes were made; this file is staged for
review (untracked by git, no commit).

**Decisions the user confirmed before any code was generated** (these are
pre-agreed, not "matches proposal" claims — they ARE the proposal):

| # | Question | Decision |
|---|----------|----------|
| 1 | Bounded-context split, Notifications deferred, separate Ledger context | Approved as proposed |
| 2 | Escrow partial releases vs full-only | **Partial releases from day one** (line entities built even if not exposed immediately). The user explicitly chose this because retrofitting amount-tracking against a binary aggregate is much more expensive than building it now. EXPIRED state was mentioned in the question but not addressed in the answer — see "open question" below. |
| 3 | Money libs | **dinero.js v2 + decimal.js** (dinero for storage/arithmetic, decimal for boundary parsing only) |
| 4 | NestJS layering | **NestJS is the interface layer only.** Domain and application layers stay plain TypeScript. Nest is a thin shell around them, not the architectural driver. |

Open question still on the table: EXPIRED as an escrow state (was in the
question list, no explicit yes/no in the four answers). The state machine on
disk does NOT include EXPIRED — only PENDING/HELD/DISPUTED/RELEASED/REFUNDED/
CANCELLED. Flagging as a question to confirm before the next increment, not a
defect.

**Methodology.** Coverage-inventory shape (P28 in the codebase-claims-audit
skill). For every layer of the design — bounded context, aggregate, port,
infrastructure adapter, cross-cutting concern — the audit reports what is
**BUILT**, what is **PARTIAL**, and what is **NOT WIRED / NOT STARTED**.

**Build sequence.** The user explicitly instructed the LLM to build:
*"next increment will be the folder structure + the Shared Kernel (Money,
IdempotencyKey, result types) with unit tests, then one context at a time."*
What is on disk matches that sequence exactly: shared kernel → payments →
escrow → ledger → provider-integration (webhook adapters first). The HTTP /
Nest wiring was the NEXT planned increment, not skipped.

**PR plan (post-audit):**

1. **UnitOfWork transaction wrapping + EXPIRED escrow state** — IN PROGRESS.
   Branch `feature/chore/uow-transaction-wrapping`. Test count 179 → 187.
2. RefundPaymentUseCase + missing escrow use cases (RefundEscrow, DisputeEscrow, ResolveDispute, CancelEscrow)
3. First outbound gateway adapter (PaystackGatewayAdapter) + integration of initializeCharge into InitiatePayment
4. HTTP/Nest layer — main.ts + AppModule + 3 webhook controllers + 4 command endpoints + raw-body middleware + webhook inbox writer

**Verification status (honest).**
- Read every `.ts` file in `src/` (74 files, ~8,840 lines including specs).
- Read the migration, `package.json`, `docker-compose.yml`, `.env.example`.
- No commits yet (`git log` fatal: master has no commits), so no diff vs. main.
- `node_modules` is installed, but `npm test` / `tsc` were not run — this audit
  is code-shape only. Runtime verification is a separate step.

---

## 1. Bounded contexts — what exists on disk

| Context               | Domain  | Application | Infrastructure | Tests        | Verdict   |
|-----------------------|---------|-------------|----------------|--------------|-----------|
| `payments/`           | ✓       | ✓           | ✓              | ✓            | BUILT (no HTTP) |
| `escrow/`             | ✓       | ✓           | ✓              | ✓            | BUILT (no HTTP) |
| `ledger/`             | ✓       | ✓           | ✓              | ✓            | BUILT (no HTTP) |
| `provider-integration/`| ✓      | ✓ (partial) | ✓ (3 adapters) | ✓            | BUILT (no HTTP, no outbound gateway) |
| `notifications/`      | —       | —           | —              | —            | NOT STARTED — matches proposal (deferred) |
| Shared kernel         | ✓       | n/a         | n/a            | ✓            | BUILT |

The proposal's five-context map matches the disk layout 1:1. The proposed
Notifications deferral is also matched — the directory does not exist. Good
adherence.

---

## 2. Shared kernel — DONE, high quality

`src/shared/kernel/` (8 files, ~590 lines):

- **`Money`** (`money.ts:211`) — integer minor units via dinero.js v2,
  currency resolution via `dinero.js/currencies`. Arithmetic refuses negative
  results, refuses mismatched currencies. `fromMajorUnits` parses a string with
  `Decimal.js`, rounds half-up at the boundary only. `allocate(ratios)` for
  splits. **Stricter than the proposal** — proposal said "zero/negative rules
  enforced at construction"; implementation forbids negatives at construction
  AND forbids subtraction results from going negative. Good.
- **`IdempotencyKey`** — branded string, regex `^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$`.
  Parse via `parseIdempotencyKey` returning `Result`. Matches proposal.
- **`ProviderName`** — closed union of `'stripe' | 'paystack' | 'flutterwave'`
  with `parseProviderName` parser. Doc explicitly justifies why this lives in
  the shared kernel. Matches proposal.
- **`DomainError`** — abstract base with a `code` field, used everywhere.
- **`DomainEvent`** — base class with `eventId` (UUID) and `occurredAt`.
- **`Result<T, E>`** — discriminated union `{ ok: true; value } | { ok: false; error }`.

Verdict: kernel is the most mature layer of the codebase. Money is the
single source of truth for "integer minor units only", enforced at the type
boundary as well as the value boundary.

---

## 3. Payments context — DONE, high quality

`src/payments/` (16 files):

### Domain
- **`PaymentIntent`** aggregate (`payment-intent.ts:331`) with:
  - Frozen `amount` + frozen `provider` from construction (matches proposal).
  - Explicit FSM in `payment-status.ts`:
    `INITIATED → {PROCESSING, FAILED, EXPIRED}`, `PROCESSING → {SUCCEEDED, FAILED, EXPIRED}`.
    No INITIATED → SUCCEEDED edge (matches proposal anti-pattern #6).
    Terminal states (SUCCEEDED/FAILED/EXPIRED) are immutable.
  - Refund invariant: cumulative refunded ≤ charged, enforced in
    `recordRefund()`. **The intent stays SUCCEEDED even when fully refunded** —
    "refunded" is a ledger fact, not a status rewrite (matches proposal).
  - `pullEvents()` drains in-memory events, called once per committed UoW.
- **`PaymentMethod`** — closed union (`card | bank_transfer | usd | mobile_money`).
- **`PaymentRouter`** (`payment-router.ts:181`) — pure function, no I/O,
  routing rules kept as data so they can be hot-swapped. Default rules:
  NGN→Paystack/Flutterwave, USD/EUR/GBP→Stripe, GHS/KES/ZAR→Flutterwave.
  Card-origin hint (`nigeria` | `international` | `unknown`) re-orders candidates
  stably. Capability filter applied last. No silent fallback on ambiguity.
- **Events**: `PaymentInitiated`, `PaymentSucceeded`, `PaymentFailed`, `RefundIssued`.
  All extend `DomainEvent`. Matches proposal exactly.

### Application
- **`InitiatePaymentUseCase`** (`initiate-payment.use-case.ts:188`):
  validate → replay → acquire → route → create → persist+journal → complete.
  Release-on-failure with `.catch(() => undefined)` so the original error
  surfaces. Matches the fintech audit's outer-policy expectation.
- **`HandlePaymentWebhookUseCase`** (`handle-payment-webhook.use-case.ts:179`):
  five defenses in order — dedup → resolve-by-provider-ref → amount-integrity →
  guarded-transition (with `isAlreadyInTargetState` absorbing crash-window
  redeliveries) → atomic journal+marker. Matches the proposal's webhook
  defence story and the fintech audit's dedup-by-event-id expectation.
- **`serializePaymentEvent`** — explicit, hand-rolled mapping from each domain
  event to a JSON-safe payload. The default branch throws
  `UnknownDomainEventError` — a new event type fails at dev time, never
  journaled half-empty.

### Infrastructure
- **`PostgresPaymentIntentRepository`** — `save` is upsert-on-`intent_id`;
  `findByProviderChargeRef` does the unique-constraint-mediated point lookup
  the migration index is built for. BIGINT columns parsed with
  `Number.isSafeInteger` validation (`pg-types.ts:toSafeInteger`).
- **`PostgresIdempotencyStore`** — `acquire` is
  `INSERT ... ON CONFLICT DO NOTHING` with rowCount-check for winner/loser.
  `complete` and `release` are conditional UPDATEs with `WHERE state = 'in-progress'`.
  Mechanical atomicity, no read-then-write race.
- **`PostgresProcessedWebhookStore`** — `processed_webhooks` table;
  `wasProcessed` SELECT 1, `markProcessed` ON CONFLICT DO NOTHING.
- **`PostgresSettledPaymentQuery`** — exists; cross-context read seam for
  escrow (`escrow/application/ports/settled-payment.query.ts`).

### Tests (4 spec files)
- `payment-intent.spec.ts`, `payment-router.spec.ts`,
  `initiate-payment.use-case.spec.ts`, `handle-payment-webhook.use-case.spec.ts`.

Verdict: payments is **architecturally complete at the domain + application
layers**. Webhook defence story and money invariants match the proposal.

---

## 4. Escrow context — DONE, high quality

`src/escrow/` (11 files):

### Domain
- **`Escrow`** aggregate (`escrow.ts:382`):
  - Cross-context reference by ID (`paymentIntentId: string`) — Escrow does not
    import Payments types. Matches proposal.
  - FSM in `escrow-state.ts`: `PENDING → {HELD, CANCELLED}`, `HELD → {DISPUTED, RELEASED, REFUNDED}`,
    `DISPUTED → HELD`. RELEASED/REFUNDED are reachable only when full
    consumption occurs (the aggregate earns the terminal state, callers never
    set it directly).
  - `Release` and `Refund` are line **entities** (immutable, with `releaseId`/
    `refundId`). The snapshot stores only running totals; full line history
    lives in the ledger (matches the "Release/Refund lines as entities from
    day one" recommendation in the proposal).
  - Partial releases are first-class — `escrow.release(amount, recipientRef, note)`.
    No separate full-release method. The invariant is
    `released + refunded ≤ held`, enforced in `assertSpendable`.
- **Events**: `EscrowInitiated`, `EscrowHeld`, `EscrowReleased(amount)`,
  `EscrowRefunded(amount)`, `EscrowDisputed`, `EscrowResolved`, `EscrowCancelled`.
  All match the proposal.

### Application
- **`PlaceEscrowHoldUseCase`** — same disciplined pipeline as InitiatePayment,
  plus two escrow-specific guards: payment must be settled (via
  `SettledPaymentQuery`), and no prior escrow may exist for the intent.
- **`ConfirmEscrowHoldUseCase`** — webhook-driven, deliberately has no
  caller-supplied idempotency key. Pipeline-level dedup via `ProcessedWebhookStore`.
  Returns `ALREADY_HELD` on idempotent re-application.
- **`ReleaseEscrowUseCase`** — same pipeline; releases (partial or full) on a
  HELD escrow, transitions to RELEASED when `availableAmount.isZero()`.

### Infrastructure
- **`PostgresEscrowRepository`** — snapshot CRUD. Exists; integration spec
  (`postgres-escrow.repository.integration-spec.ts`) exists.

### Tests
- `escrow.spec.ts`, `escrow.use-cases.spec.ts`.

Verdict: escrow is **architecturally complete**. The "partial releases are
first-class line entities" decision from the proposal is implemented, and
the state machine is earned, not settable.

---

## 5. Ledger context — DONE, high quality (Option A from proposal)

`src/ledger/` (7 files):

- **`LedgerEntry`** (`ledger-entry.ts:135`) — immutable (deep-frozen at
  construction), payload validated JSON-serializable via
  `JSON.stringify(structuredClone(...))`. `entryId` and `recordedAt` are
  journal-generated, never caller-supplied. Matches "append-only, not
  mutated in place" non-negotiable.
- **Sequence numbering** (`sequence.ts:52`) — per-aggregate monotonic,
  `assertNextSequence` enforces `next === (last ?? 0) + 1`. Throws
  `SequenceGapError` on violation. The migration's `UNIQUE(aggregate_id,
  sequence)` is the database-level tripwire; the in-memory check is the
  domain-level one. They agree on what a gap is.
- **`LedgerAppender`** (`ledger-appender.ts:70`) — context-independent; each
  caller supplies its own event serializer (Payments and Escrow have
  matching serializers in their own folders). Matches proposal's "context-
  independent, projection module reads from one event stream" idea.
- **`PostgresLedgerRepository`** — multi-row INSERT with
  `ON CONFLICT (aggregate_id, sequence) DO NOTHING`. rowCount shortfall is
  translated to `SequenceGapError` so callers see one failure mode.

### Tests
- `ledger-entry.spec.ts`, `sequence.spec.ts`.

Verdict: ledger matches the proposal's Option A exactly. Append-only,
context-independent, per-aggregate sequence, single-statement atomic append.

---

## 6. ProviderIntegration context — PARTIAL (adapter side done, gateway side missing)

`src/provider-integration/` (13 files):

### Port — DONE
- **`PaymentGatewayPort`** (`payment-gateway.port.ts:125`):
  `initializeCharge` returns a normalized `InitializedCharge` (NOT "success"),
  `verifyCharge` returns a normalized `ChargeVerification` (also NOT settlement
  truth). The reconciliation contract between initialize and webhook is
  documented in the interface doc-comment. Matches proposal.
- **`ProviderWebhookPort`** (`provider-webhook.port.ts:31`):
  `verifyAndNormalizeWebhook(rawBody: Buffer, headers)` — single async call
  that does BOTH signature verification AND normalization. Matches proposal's
  "those two steps must never be separable" principle.

### Domain — DONE
- **`NormalizedPaymentEvent`** (`normalized-payment-event.ts:120`):
  closed enum `NORMALIZED_EVENT_TYPES = [CHARGE_SUCCEEDED, CHARGE_FAILED,
  REFUND_COMPLETED, TRANSFER_COMPLETED, TRANSFER_FAILED]`. Constructor
  validates non-empty fields and amount/currency co-presence. Matches
  proposal.

### Adapters — DONE (3 of 3)
- **Paystack** (`paystack-webhook.adapter.ts:233`):
  - HMAC-SHA512 over raw bytes using `crypto.createHmac`.
  - `timingSafeEqual` for compare (correctly throws on length mismatch).
  - zod schema validation per event type.
  - Three event mappings: `charge.success` → CHARGE_SUCCEEDED,
    `transfer.{success|failed|reversed}` → TRANSFER_{COMPLETED|FAILED},
    `refund.processed` → REFUND_COMPLETED.
  - **Deliberately no `charge.failed` mapping** — Paystack does not emit one
    (adapter doc-comment explains; CHARGE_FAILED in the enum exists for
    Flutterwave/Stripe). Matches proposal's "do not guess" principle.
  - Synthetic `eventId = paystack:{transactionId}:{event}` for dedup.
  - Disputes, `refund.failed/pending/processing` rejected as UNRECOGNIZED.
- **Flutterwave** (`flutterwave-webhook.adapter.ts:323`) — same shape.
  Different signature scheme (verifies hash + secret-hash headers).
- **Stripe** (`stripe-webhook.adapter.ts:308`) — same shape. Uses Stripe's
  `constructEvent` via the shared `HttpClient`.

### Gateway side — NOT BUILT
Grep `createSubaccount | createTransferRecipient | initiateTransfer |
verifyTransfer | createSplit | captureCharge` — zero hits in `src/`.
**No concrete payment-gateway adapter implements `PaymentGatewayPort`.**
`paystack-gateway.schemas.ts` exists (just zod response schemas) but there is
no `PaystackGatewayAdapter` class.

The `PaymentGatewayPort` is declared but has no production-side
implementation. `InitiatePaymentUseCase` does NOT call the gateway — it
creates the intent, journals the event, and returns. There is no call to
`provider.initializeCharge(input)` anywhere in the codebase.

### Tests
- All three adapters have spec files (Paystack 232, Flutterwave 333, Stripe 306
  lines). Spec coverage on the webhook side is solid.

Verdict: **the inbound (webhook) direction is wired and well-tested**.
**The outbound (gateway) direction has the port declared but no
implementation.** This is consistent with the proposal's "verifier is the
first adapter; gateway adapters come later" reading, but should be tracked
explicitly — see §9 below.

---

## 7. Cross-cutting concerns

### Idempotency — DONE
- Outer policy: every use-case (initiate-payment, place-hold, release) runs
  validate → replay → acquire → execute → complete; release-on-failure.
- Inner constraint: `idempotency_keys` PK is `(scope, key)`. `acquire` is
  `INSERT ... ON CONFLICT DO NOTHING` — one statement, no race.
- `payment_intents.idempotency_key` is `UNIQUE` (migration line 30) — the
  unique-constraint backstop the fintech audit recipe asks for.
- `escrows.payment_intent_id` is `UNIQUE` (migration line 56) — the
  one-hold-per-settlement backstop.

### Webhook — DONE (inbound only; no HTTP layer yet)
- `processed_webhooks.event_id` PK (migration line 106) — `wasProcessed` is a
  primary-key lookup. `markProcessed` is `INSERT ... ON CONFLICT DO NOTHING`.
- `webhook_inbox` table exists (migration line 113) for replay support;
  **no repository or write path currently populates it**. The migration
  comment says "the repair source when a SequenceGapError fires", but the
  use-case does not currently write to it.

### Outbox — DONE (in-memory)
- Domain events are collected in the aggregate (`domainEvents[]`), drained
  by the application layer (`pullEvents`), and journaled by `LedgerAppender`.
  The ledger is the outbox. Matches the proposal.

### Unit of Work — PARTIAL (defined, never used)
- **`UnitOfWork`** (`unit-of-work.ts:45`) — exists, implements `BEGIN/COMMIT`
  with best-effort `ROLLBACK`. Doc-comment shows the intended usage:
  `intentRepo.with(tx).save(intent)`.
- **No repository has a `with(tx)` method.** `grep "with(tx)"` returns zero
  hits in `src/`.
- **No use-case wraps its multi-step persistence in `unitOfWork.run(...)`.**
  Grep confirms `UnitOfWork`/`unitOfWork` only appears in its own file.
- **Consequence:** today, `InitiatePaymentUseCase` does
  `await this.deps.intents.save(intent); await this.deps.ledger.append(...)`.
  These are **two separate autocommit statements, not one transaction**.
  If `intents.save` commits and `ledger.append` fails (network blip, db
  restart), the snapshot is mutated but the journal is not — the audit
  history is broken relative to the snapshot.
- This is exactly the invariant the migration comments and the unit-of-work
  doc-comment promise. **It is currently false at runtime.**

### Money math — DONE
- All monetary columns are `BIGINT` (migration convention).
- All arithmetic routes through `Money` (dinero.js v2).
- `Money.fromMajorUnits` rounds half-up at parse time only.
- All repos parse with `Number.isSafeInteger` validation.

### Tenant / multi-tenancy — NOT ADDRESSED
- No `tenantId` column anywhere. The proposal did not name this
  specifically, but a payments service that may eventually be called by
  multiple calling apps usually needs tenant scoping on intents and
  idempotency. Currently the schema has zero tenant concept.
- **Status:** NOT STARTED. Flag as a forward-looking concern, not a
  defect against the proposal.

### Audit logging — NOT ADDRESSED
- The proposal's "Audit logging likewise (decorator/interceptor,
  non-negotiable #9)" is mentioned in design notes but there is no
  audit decorator / interceptor / logger in `src/`. The ledger entries
  ARE the audit trail — and that's the right call for financial state —
  but the proposal's "every command emits an audit record" idea is
  satisfied only insofar as every command emits domain events.

---

## 8. Money library decision — IMPLEMENTED AS PROPOSED

`package.json` lists both:
- `dinero.js: ^2.0.2`
- `decimal.js: ^10.6.0`

Matches proposal: dinero for storage + integer arithmetic, decimal for
boundary parsing only. The grep shows decimal used only inside
`money.ts:fromMajorUnits` — clean boundary.

---

## 9. NOT WIRED / NOT STARTED — the gap list

The list below is the **next-increment backlog**, not a defect report.
Per the user's build instruction ("kernel + one context at a time, then the
HTTP layer"), the disk is exactly where the agreed sequence says it should
be. What follows is the work the user has NOT yet asked the LLM to start.

### P0 — Next increment per agreed sequence: HTTP + gateway adapters

The interface layer is the natural next chunk. The LLM was told to stop at
domain/application and the inbound adapters; what remains is the outbound
side of the same boundary, plus the Nest wiring to expose everything.

1. **HTTP / Nest wiring.** Greps that should hit and don't:
   - `from '@nestjs/common'` — zero hits
   - `NestFactory` — zero hits
   - `@Controller` — zero hits
   - `@Module` — zero hits
   - `@Injectable` — zero hits

   No `src/main.ts`, no `src/app.module.ts`, no controllers. The
   `@nestjs/*` deps in `package.json` are aspirational; nothing imports
   them yet. Missing:
   - Webhook controllers `POST /webhooks/{paystack,stripe,flutterwave}`
     that read raw body and call `adapter.verifyAndNormalizeWebhook(rawBody,
     headers)`. The `Buffer` raw-body requirement means a custom raw-body
     middleware (or `bodyParser: { raw: { type: '*/*' } }`) is mandatory.
   - Command endpoints, at minimum:
     - `POST /payments` — intake for `InitiatePaymentUseCase`
     - `POST /escrows` — intake for `PlaceEscrowHoldUseCase`
     - `POST /escrows/{id}/releases` — intake for `ReleaseEscrowUseCase`
     - `POST /payments/{id}/refunds` — intake for a refund use case
       (see #5 below)
   - Composition root / DI module — `AppModule` declaring which port is
     bound to which Postgres / adapter implementation, env var injection,
     pool lifecycle.

   This is the largest single increment in the remaining work. The
   domain and application code is already Nest-free plain TypeScript
   (decision #4: "NestJS is the interface layer only"), so the shell
   writes are local to a new `src/interface/` (or similar) folder plus
   `src/main.ts`.

2. **Outbound payment gateway adapter.** `PaymentGatewayPort` is declared.
   Grep `createSubaccount | createTransferRecipient | initiateTransfer |
   verifyTransfer | createSplit | captureCharge` — zero hits in `src/`.
   No concrete gateway adapter implements `PaymentGatewayPort`.
   `InitiatePaymentUseCase` does NOT call the provider — it creates the
   intent, journals the event, and returns. There is no call to
   `provider.initializeCharge(input)` anywhere in the codebase.

   Concretely missing for each of Stripe / Paystack / Flutterwave:
   - `PaystackGatewayAdapter implements PaymentGatewayPort` — POST to
     `https://api.paystack.co/transaction/initialize` with bearer auth,
     parsing the response into `InitializedCharge` (checkoutUrl,
     providerReference). The `paystack-gateway.schemas.ts` zod schemas
     are already on disk waiting for this.
   - Equivalent for Flutterwave (`/payments` endpoint) and Stripe
     (`/v1/payment_intents`).
   - Integration of the gateway call into the initiate-payment pipeline
     — after `routePayment`, before returning the result. Should use
     `intent.markProcessing(providerReference)` to record the
     reconciliation key once the gateway accepts the charge.
   - Wiring `verifyCharge` into a polling fallback for webhooks lost in
     transit (mentioned in the port doc-comment).

### P1 — Defined but not wired: same increment or the one after

3. **UnitOfWork not used.** `InitiatePaymentUseCase`,
   `PlaceEscrowHoldUseCase`, `ReleaseEscrowUseCase`, and
   `HandlePaymentWebhookUseCase` all do **two or more separate awaited
   DB operations** (intents.save + ledger.append + processed_webhooks.
   markProcessed) as separate autocommit statements. Without a transaction
   wrapper, a failure between operations leaves the journal and the
   snapshot inconsistent.

   `UnitOfWork` is built for exactly this with correct `BEGIN/COMMIT/
   ROLLBACK` semantics — it just isn't called. Every repository's
   `save`/`append`/`markProcessed` would need to be routed through the
   same `tx` executor (`SqlExecutor` type already permits this, since
   `Pool` and `PoolClient` both satisfy it). Recommended to fix in the
   same increment as the HTTP layer so the first controller written
   inherits the correct atomicity.

4. **No webhook inbox writer.** The `webhook_inbox` table is created in
   the initial migration but no code ever writes to it. The migration
   comment calls it "the repair source when a SequenceGapError fires" —
   meaning, when the ledger says "expected sequence 5, got 4", you should
   be able to inspect the raw inbox to find the missing event and replay
   it. Without a writer, that table is dead schema.

   The right writer is in the inbound webhook controller: after
   `verifyAndNormalizeWebhook`, insert the raw body + verified flag +
   parsed metadata into `webhook_inbox` in the SAME transaction as the
   `processed_webhooks` marker write. Bundles naturally with #3 and the
   HTTP layer.

5. **Refund use case is missing on the application side.**
   `PaymentIntent.recordRefund(amount)` exists in the domain with full
   invariant guarding (status must be SUCCEEDED, cumulative ≤ charged,
   currency must match). The `RefundIssued` event exists. But there is
   no `RefundPaymentUseCase` to be the application-layer entry point —
   no idempotency-wrapped orchestration, no journal write, no call to
   the provider's refund API (which itself doesn't exist as an adapter;
   see #2). The proposal listed refund handling under Payments as a
   domain event but did not enumerate a refund use case by name;
   flagging as a gap to fill alongside the HTTP layer.

### P2 — Application-layer coverage gaps (escrow)

Three escrow use-cases exist (`PlaceEscrowHoldUseCase`,
`ConfirmEscrowHoldUseCase`, `ReleaseEscrowUseCase`). Missing:
- **`RefundEscrowUseCase`** — `escrow.refund(amount, note)` exists.
- **`DisputeEscrowUseCase`** — `escrow.dispute(reason)` exists.
- **`ResolveDisputeUseCase`** — `escrow.resolveDispute()` exists.
- **`CancelEscrowUseCase`** — `escrow.cancel(reason)` exists.

This is consistent with the proposal's "model Release/Refund lines as
entities from day one" — the refunds are modelled, but the use cases
weren't all built. The remaining four are small additions following the
same shape as `ReleaseEscrowUseCase`. Decide whether all four ship in the
next increment or whether some can wait for the first consumer.

### P3 — Schema / operational hygiene

- **`webhook_inbox` parsed-metadata columns are not populated.** Schema
  has `provider`, `event_id`, `event_type`, `payload`, `signature_valid`.
  Will populate naturally when the writer from #4 lands.
- **`processed_webhooks` and `webhook_inbox` lack `aggregate_id`.** When
  replaying, the join `processed_webhooks.event_id → webhook_inbox →
  ledger_entries.aggregate_id` is not directly available without
  parsing the raw payload. A denormalized `aggregate_id` column on either
  table would speed up SequenceGapError repair queries. Optional.
- **No operational surface.** No `GET /health`, no `GET /ready`, no
  metrics, no structured logger, no graceful shutdown. Out of scope for
  the design proposal; flagging for awareness when the HTTP layer lands.
- **No tenant / multi-tenancy.** No `tenantId` column anywhere. The
  proposal did not name this specifically; a payments service that may
  eventually be called by multiple calling apps usually needs tenant
  scoping on intents and idempotency. Forward-looking, not a defect.

### P3 — Documentation hygiene (one-time, before next person reads the repo)

- **README.md is unmodified NestJS boilerplate.** Still says "Nest
  framework TypeScript starter repository" — the actual project
  description, architecture summary, and run instructions are scattered
  across `migrations/1720000000000_initial-schema.js` comments and
  per-file JSDoc. Should be rewritten to point at the four built
  contexts, the agreed layering (Nest as interface shell only), and
  how to run the integration suite.

---

## 10. Match vs. proposal + your four confirmed decisions

| Proposal item / confirmed decision                                 | On disk? | Notes |
|--------------------------------------------------------------------|----------|-------|
| Five contexts, one shared kernel (decision #1)                     | ✓        | Notifications deliberately deferred (matches decision #1). |
| Ledger as its own context with projections                         | ✓        | Option A implemented. Append-only, per-aggregate sequence, context-independent appender. |
| Closed `ProviderName` union with `parseProviderName`               | ✓        | Strict. |
| `IdempotencyKey` VO, branded, regex-validated                      | ✓        | Strict. |
| `Money` VO, integer minor units only, no JS-number parsing        | ✓        | Stricter than proposal (also forbids negative subtraction). |
| Money libs: dinero.js v2 + decimal.js (decision #3)                | ✓        | dinero for storage/arithmetic, decimal only at the boundary parse in `Money.fromMajorUnits`. |
| `PaymentIntent` aggregate, FSM, terminal immutability, refund guard | ✓        | Implemented exactly as proposed. |
| `PaymentRouter` as a pure domain service                          | ✓        | Implemented with default routing rules + card-origin hint. |
| `Escrow` aggregate, partial releases as line entities (decision #2)| ✓        | Implemented; partial releases are first-class. |
| Escrow FSM: PENDING/HELD/DISPUTED/RELEASED/REFUNDED/CANCELLED      | ✓        | Exact match. EXPIRED state is **not** included on the escrow side (see open question in §11). |
| `LedgerEntry` immutable, JSON-safe, journal-generated entryId     | ✓        | Implemented. |
| Per-aggregate sequence with `SequenceGapError`                     | ✓        | Implemented; DB-level UNIQUE constraint backstops. |
| `PaymentProviderPort` + `ProviderWebhookPort` as separate interfaces | ✓       | Implemented. |
| HMAC over raw body, `Buffer` not string                            | ✓        | Implemented in all three webhook adapters. |
| `NormalizedPaymentEvent` with closed `NormalizedEventType` enum     | ✓        | 5 types (CHARGE_*, TRANSFER_*, REFUND_COMPLETED). |
| Unknown provider event types → reject, never pass-through          | ✓        | `UnrecognizedProviderEventError` thrown in adapters. |
| `ProviderApiError` vs `HttpTransportError` distinction             | ✓        | Both defined in `provider-integration/application/errors.ts`. |
| NestJS as the interface layer only (decision #4)                  | ✓        | Zero `@nestjs/*` imports in `src/`; domain/application stays plain TS. |
| Outbox pattern: events drained after successful UoW                | PARTIAL  | In-memory collection is correct. UoW wrapping is missing (see §9 #3). |
| Webhook dedup via `processed_webhooks.event_id` PK                 | PARTIAL  | Table + reader/writer exist; no controller wires the writer. |
| Outbound payment gateway adapter                                   | PARTIAL  | Port declared, no implementation; `initializeCharge` is never called. |
| HTTP / Nest controllers + composition root                         | NOT YET  | Agreed next increment per the build sequence. |
| Tenant / multi-tenancy                                             | ✗        | Not addressed in the proposal; flagging as forward concern. |
| Notifications context                                              | DEFERRED | Matches proposal decision (deferred). |

---

## 11. Summary for the user

**Reframing the headline.** The original draft of this audit led with
"the service has no HTTP layer at all and no outbound gateway adapter, so
it cannot be started" — that's accurate but unfair. Per the brief you gave
the LLM, the agreed build sequence was:

1. Folder structure + Shared Kernel with unit tests
2. One context at a time (Payments → Escrow → Ledger → ProviderIntegration,
   webhook adapters first)
3. **HTTP / Nest wiring as the NEXT increment**

The disk reflects exactly that: shared kernel is mature, all four contexts
are built to domain + application + (where applicable) Postgres
infrastructure, the inbound webhook adapters are wired and tested. The
HTTP layer is **the agreed next chunk**, not a missed requirement.

**What is genuinely good and ready to build on:**

- Money, IdempotencyKey, ProviderName, PaymentMethod VOs are tight.
- PaymentIntent FSM and refund invariants are exactly the proposal's shape.
- PaymentRouter is a pure function, fully testable, with sensible default
  rules.
- Escrow aggregate's "line entities + earned terminal states" is correct
  and matches the proposal's recommendation (decision #2).
- LedgerEntry immutability + sequence numbering + multi-row atomic append
  are well-engineered.
- All three webhook adapters follow the same disciplined pattern: HMAC
  over raw body, zod validation, closed-enum mapping, explicit rejection
  of unknown events.
- The migration captures the schema conventions (BIGINT, UUIDs, journal-
  generated timestamps) in a comment block that future contributors will
  actually read.
- dinero.js v2 + decimal.js installed exactly as you specified (decision #3).
- Domain and application code has zero `@nestjs/*` imports — clean plain
  TypeScript per decision #4. The interface layer can be added without
  touching any of this.

**What's left, by priority, all of which is the "next increment" backlog:**

1. **HTTP / Nest wiring (the agreed next chunk).** No `main.ts`, no
   `AppModule`, no controllers. Webhook controllers + command endpoints +
   composition root. Largest single piece of remaining work.
2. **Outbound gateway adapters.** `PaymentGatewayPort` is declared but no
   implementation exists for any provider. `initializeCharge` is never
   called. The reconciliation contract the port documents is unfillable
   until these adapters land.
3. **UnitOfWork wiring.** Defined but not used. Multi-step persistence
   across intents/ledger/processed-webhooks is not atomic. Should land
   in the same increment as the HTTP layer so the first controller
   inherits correct atomicity.
4. **Webhook inbox writer.** Table exists, no writer.
5. **RefundPaymentUseCase + missing escrow use cases** (Refund/Dispute/
   Resolve/Cancel). Domain methods exist; application entry points
   don't yet.
6. **README rewrite.** Still NestJS boilerplate; the architecture
   narrative lives in migration comments and JSDoc instead.

**Open questions to confirm before the next increment:**

1. **EXPIRED as an escrow state** — was in question 2 of the original
   four-question brief, but your answer covered partial releases only.
   The state machine on disk does NOT include EXPIRED (the Payments
   side does — `PaymentStatus.EXPIRED` is in `payment-status.ts`). If
   you want escrow to also support EXPIRED (time-bound holds that lapse
   without settlement), the domain needs a `escrow.expire(reason)`
   method plus a PENDING → EXPIRED edge in the FSM. Small addition
   if desired; flag it before the next increment.

**What is forward-looking, not a defect against this proposal or your
brief:**

- No tenant scoping on intents/escrows/ledger. The proposal didn't
  include it; flagging as a forward concern.
- No notifications/ — explicitly deferred (matches your decision #1).
- No operational surface (/health, metrics, structured logger). Will
  land naturally with the HTTP layer if you want it then.