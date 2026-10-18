import { LedgerAppender } from '../../ledger/application/ledger-appender';
import type { LedgerRepository } from '../../ledger/application/ports/ledger-repository';
import type { LedgerEntry } from '../../ledger/domain/ledger-entry';
import { assertNextSequence } from '../../ledger/domain/sequence';
import { NormalizedPaymentEvent } from '../../provider-integration/domain/normalized-payment-event';
import { ok, type Result } from '../../shared/kernel/result';
import type { ProviderName } from '../../shared/kernel/provider-name';
import type { DomainError } from '../../shared/kernel/domain-error';
import type { Pool } from 'pg';
import type { SqlExecutor } from '../../shared/infrastructure/db';
import { optimisticSave } from '../../shared/infrastructure/in-memory-cas';
import { UnitOfWork } from '../../shared/infrastructure/unit-of-work';
import { type IdempotencyKey } from '../../shared/kernel/idempotency-key';
import { IllegalPaymentStatusTransitionError } from '../domain/errors';
import type { PaymentIntent } from '../domain/payment-intent';
import type { IdempotencyStore } from './ports/idempotency-store';
import type { PaymentIntentRepository } from './ports/payment-intent.repository';
import type { ProcessedWebhookStore } from './ports/processed-webhook-store';
import type { WebhookInboxStore } from '../../provider-integration/application/ports/webhook-inbox.store';
import type {
  PaymentGatewayPort,
  InitializeChargeInput,
  InitializedCharge,
} from '../../provider-integration/application/ports/payment-gateway.port';
import { InitiatePaymentUseCase } from './initiate-payment.use-case';
import {
  HandlePaymentWebhookUseCase,
  type WebhookHandlingResult,
} from './handle-payment-webhook.use-case';
import {
  UnknownProviderReferenceError,
  UnsupportedEventTypeError,
  WebhookAmountMismatchError,
} from './errors';

// --------------------------------------------------------------------- //
// In-memory fakes — same contract-testing role as in the InitiatePayment  //
// spec: they mirror the port doc comments so use-case tests double as     //
// executable documentation for the adapters.                              //
// --------------------------------------------------------------------- //

class InMemoryIdempotencyStore implements IdempotencyStore {
  private states = new Map<
    string,
    { state: 'in-progress' } | { state: 'completed'; result: unknown }
  >();

  getCompleted<T>(scope: string, key: IdempotencyKey): Promise<T | null> {
    const record = this.states.get(`${scope}:${key}`);
    return Promise.resolve(
      record?.state === 'completed' ? (record.result as T) : null,
    );
  }

  acquire(
    scope: string,
    key: IdempotencyKey,
  ): Promise<'acquired' | 'in-progress'> {
    const composite = `${scope}:${key}`;
    if (this.states.has(composite)) return Promise.resolve('in-progress');
    this.states.set(composite, { state: 'in-progress' });
    return Promise.resolve('acquired');
  }

  complete(scope: string, key: IdempotencyKey, result: unknown): Promise<void> {
    this.states.set(`${scope}:${key}`, { state: 'completed', result });
    return Promise.resolve();
  }

  release(scope: string, key: IdempotencyKey): Promise<void> {
    this.states.delete(`${scope}:${key}`);
    return Promise.resolve();
  }

  with(_tx: SqlExecutor): InMemoryIdempotencyStore {
    void _tx;
    return this;
  }
}

class InMemoryPaymentIntentRepository implements PaymentIntentRepository {
  private intents = new Map<string, PaymentIntent>();

  save(intent: PaymentIntent): Promise<void> {
    optimisticSave(this.intents, intent, (i) => i.intentId, 'PaymentIntent');
    return Promise.resolve();
  }

  findById(intentId: string): Promise<PaymentIntent | null> {
    return Promise.resolve(this.intents.get(intentId) ?? null);
  }

  findByProviderChargeRef(
    provider: ProviderName,
    providerRef: string,
  ): Promise<PaymentIntent | null> {
    for (const intent of this.intents.values()) {
      if (
        intent.provider === provider &&
        intent.chargeReference === providerRef
      ) {
        return Promise.resolve(intent);
      }
    }
    return Promise.resolve(null);
  }

  with(_tx: SqlExecutor): InMemoryPaymentIntentRepository {
    void _tx;
    return this;
  }
}

class InMemoryLedgerRepository implements LedgerRepository {
  private entries: LedgerEntry[] = [];

  lastSequence(aggregateId: string): Promise<number | undefined> {
    const forAggregate = this.entries.filter(
      (e) => e.aggregateId === aggregateId,
    );
    return Promise.resolve(
      forAggregate.length === 0
        ? undefined
        : Math.max(...forAggregate.map((e) => e.sequence)),
    );
  }

  async append(newEntries: readonly LedgerEntry[]): Promise<void> {
    for (const entry of newEntries) {
      assertNextSequence(
        entry.aggregateType,
        entry.aggregateId,
        await this.lastSequence(entry.aggregateId),
        entry.sequence,
      );
      this.entries.push(entry);
    }
  }

  all(): readonly LedgerEntry[] {
    return this.entries;
  }

  with(_tx: SqlExecutor): InMemoryLedgerRepository {
    void _tx;
    return this;
  }
}

class InMemoryProcessedWebhookStore implements ProcessedWebhookStore {
  private processed = new Set<string>();

  wasProcessed(eventId: string): Promise<boolean> {
    return Promise.resolve(this.processed.has(eventId));
  }

  markProcessed(eventId: string): Promise<void> {
    this.processed.add(eventId);
    return Promise.resolve();
  }

  with(_tx: SqlExecutor): InMemoryProcessedWebhookStore {
    void _tx;
    return this;
  }
}

/**
 * In-memory fake of {@link WebhookInboxStore}. Records every event
 * passed to `recordVerifiedWebhook`, keyed by the normalized
 * `provider + event_id` so a redelivery is a no-op (matching the
 * Postgres adapter's ON CONFLICT semantics).
 *
 * The map is exposed via a `getRecorded()` accessor so the spec
 * can assert that the use case wrote a row. The accessor is
 * testing-only — production code must not read the inbox.
 */
class InMemoryWebhookInboxStore implements WebhookInboxStore {
  private readonly rows: Array<{
    provider: string;
    eventId: string;
    eventType: string;
    payload: Record<string, unknown>;
    signatureValid: boolean;
    receivedAt: Date;
  }> = [];
  // Used for O(1) idempotency check, mirroring the unique index
  // on (provider, event_id) in the Postgres schema.
  private readonly seen = new Set<string>();

  async recordVerifiedWebhook(event: NormalizedPaymentEvent): Promise<void> {
    // Promise.resolve() (rather than no async) keeps the port's
    // return type signature consistent across adapters — every
    // implementation is `Promise<void>`, regardless of whether
    // there's real I/O behind it.
    await Promise.resolve();
    const key = `${event.provider}:${event.eventId}`;
    if (this.seen.has(key)) return;
    this.seen.add(key);
    this.rows.push({
      provider: event.provider,
      eventId: event.eventId,
      eventType: event.type,
      payload: {
        eventId: event.eventId,
        provider: event.provider,
        type: event.type,
        providerRef: event.providerRef,
        occurredAt: event.occurredAt.toISOString(),
        ...(event.amountMinor !== undefined
          ? { amountMinor: event.amountMinor }
          : {}),
        ...(event.currency !== undefined ? { currency: event.currency } : {}),
        ...(event.failureReason !== undefined
          ? { failureReason: event.failureReason }
          : {}),
        ...(event.raw !== undefined ? { raw: event.raw } : {}),
      },
      signatureValid: true,
      receivedAt: event.occurredAt,
    });
  }

  with(_tx: SqlExecutor): InMemoryWebhookInboxStore {
    void _tx;
    return this;
  }

  /** Testing-only: returns a snapshot of recorded rows. */
  getRecorded(): ReadonlyArray<{
    provider: string;
    eventId: string;
    eventType: string;
  }> {
    return this.rows.map((r) => ({
      provider: r.provider,
      eventId: r.eventId,
      eventType: r.eventType,
    }));
  }
}

/**
 * Minimal in-memory PaymentGatewayPort fake. The webhook
 * handler doesn't care what the gateway did, only that the
 * intent has a `chargeReference` to match webhooks against. The
 * fake echoes the input `reference` as `providerReference`,
 * which is the same value the test asserts on (CHARGE_REF /
 * 'evt_provider_123'). If a test needs the gateway to fail it
 * can replace the harness's gateway instance with one that
 * returns a ProviderApiError.
 */
import { rehydrateTenantId, type Principal } from '../../shared/kernel/tenant';

/**
 * The single test principal used across this spec. The fixture
 * creates intents via `InitiatePayment.execute`, which reads
 * `principal.tenantId` and stamps it onto the freshly-created
 * intent. The webhook handler then asserts the intent's
 * `tenantId` matches the inbound event's intent, so a mismatch
 * would short-circuit at the lookup stage.
 */
const TEST_TENANT = rehydrateTenantId('a1b2c3d4-1111-4222-8333-444444444444');
const TEST_PRINCIPAL: Principal = {
  kind: 'app',
  appId: 'app-uuid-test',
  tenantId: TEST_TENANT,
  scopes: ['payments:write', 'escrows:write'],
  expiresAt: new Date('2030-01-01T00:00:00Z'),
};

class RecordingGatewayAdapter implements PaymentGatewayPort {
  readonly provider: ProviderName = 'paystack';
  readonly calls: InitializeChargeInput[] = [];
  /** Hard-coded reference — matches CHARGE_REF in the webhookEvent fixture. */
  private static readonly FIXED_PROVIDER_REFERENCE = 'PAYSTACK-CHARGE-REF-1';

  async initializeCharge(
    input: InitializeChargeInput,
  ): Promise<Result<InitializedCharge, DomainError>> {
    await Promise.resolve();
    this.calls.push(input);
    return ok({
      // Real Paystack echoes the input `reference` back as the
      // providerReference. The test fixture hard-codes a known
      // value (CHARGE_REF) so the webhook's `providerRef` matches
      // the intent's `chargeReference`. In production the same
      // property holds because both come from the same idempotency
      // key — but the fixture decouples them so an idempotency-key
      // change doesn't cascade into test churn.
      providerReference: RecordingGatewayAdapter.FIXED_PROVIDER_REFERENCE,
      checkoutUrl: 'https://checkout.test/inmem',
      raw: { testEcho: true, sentReference: input.reference },
    });
  }
  async verifyCharge(providerReference: string): Promise<
    Result<
      {
        status: 'PENDING';
        providerReference: string;
        amountMinor: number;
        currency: string;
        raw: unknown;
      },
      DomainError
    >
  > {
    await Promise.resolve();
    return ok({
      status: 'PENDING',
      providerReference,
      amountMinor: 0,
      currency: 'NGN',
      raw: { testEcho: true },
    });
  }
}

function gatewayMap(
  entries: ReadonlyArray<PaymentGatewayPort>,
): ReadonlyMap<ProviderName, PaymentGatewayPort> {
  const m = new Map<ProviderName, PaymentGatewayPort>();
  for (const a of entries) m.set(a.provider, a);
  return m;
}

/** Noop unit-of-work: just runs the callback with a stub tx. */
class InMemoryUnitOfWork extends UnitOfWork {
  constructor() {
    super({} as Pool);
  }
  async run<T>(work: (tx: SqlExecutor) => Promise<T>): Promise<T> {
    return work({} as SqlExecutor);
  }
}

// --------------------------------------------------------------------- //
// Fixture wiring                                                          //
// --------------------------------------------------------------------- //

const CHARGE_REF = 'PAYSTACK-CHARGE-REF-1';

function webhookEvent(
  overrides: Partial<
    ConstructorParameters<typeof NormalizedPaymentEvent>[0]
  > = {},
): NormalizedPaymentEvent {
  return new NormalizedPaymentEvent({
    eventId: 'evt_provider_123',
    provider: 'paystack',
    type: 'CHARGE_SUCCEEDED',
    providerRef: CHARGE_REF,
    occurredAt: new Date('2026-09-21T12:05:00.000Z'),
    amountMinor: 25_000,
    currency: 'NGN',
    ...overrides,
  });
}

interface Harness {
  handler: HandlePaymentWebhookUseCase;
  intents: InMemoryPaymentIntentRepository;
  ledger: InMemoryLedgerRepository;
  processed: InMemoryProcessedWebhookStore;
  inbox: InMemoryWebhookInboxStore;
}

/**
 * Full realistic setup: a payment enters through InitiatePayment (journaling
 * PaymentInitiated), the provider accepts the charge (markProcessing +
 * save), and a webhook arrives. The handler under test sees the world
 * exactly as it will exist in production.
 */
async function makeHarness(): Promise<{ harness: Harness; intentId: string }> {
  const intents = new InMemoryPaymentIntentRepository();
  const ledger = new InMemoryLedgerRepository();
  const processed = new InMemoryProcessedWebhookStore();
  const inbox = new InMemoryWebhookInboxStore();
  const unitOfWork = new InMemoryUnitOfWork();

  const initiate = new InitiatePaymentUseCase({
    principal: TEST_PRINCIPAL,
    idempotency: new InMemoryIdempotencyStore(),
    intents,
    ledger: new LedgerAppender(ledger),
    gateways: gatewayMap([new RecordingGatewayAdapter()]),
    unitOfWork,
  });
  const started = await initiate.execute({
    amountMinor: 25_000,
    currency: 'NGN',
    method: 'card',
    idempotencyKey: 'charge-order-000042',
  });
  if (!started.ok) throw new Error('fixture setup failed');
  const intentId = started.value.intentId;

  // The gateway call inside InitiatePayment.execute already moves
  // the intent from INITIATED → PROCESSING and persists it. The
  // fixture used to manually call markProcessing + save here to
  // simulate that step; that's no longer needed now that the
  // use case exercises the real gateway path. We still need the
  // intent to be in PROCESSING for the webhook tests, which it
  // already is.
  const intent = await intents.findById(intentId);
  if (!intent) throw new Error('fixture intent missing');
  if (intent.currentStatus !== 'PROCESSING') {
    throw new Error(
      `fixture setup: expected intent in PROCESSING, got ${intent.currentStatus}`,
    );
  }

  const handler = new HandlePaymentWebhookUseCase({
    intents,
    ledger: new LedgerAppender(ledger),
    processedWebhooks: processed,
    webhookInbox: inbox,
    unitOfWork,
  });
  return { harness: { handler, intents, ledger, processed, inbox }, intentId };
}

function unwrap(
  result:
    | { ok: true; value: WebhookHandlingResult }
    | { ok: false; error: DomainError },
): WebhookHandlingResult {
  if (!result.ok) throw new Error(`expected success, got ${result.error.code}`);
  return result.value;
}

// --------------------------------------------------------------------- //
// Tests                                                                   //
// --------------------------------------------------------------------- //

describe('HandlePaymentWebhookUseCase', () => {
  it('applies CHARGE_SUCCEEDED: intent settles and PaymentSucceeded is journaled', async () => {
    const { harness, intentId } = await makeHarness();

    const result = unwrap(await harness.handler.execute(webhookEvent()));

    expect(result).toEqual({ outcome: 'APPLIED', intentId });
    const intent = await harness.intents.findById(intentId);
    expect(intent?.currentStatus).toBe('SUCCEEDED');

    const entries = harness.ledger
      .all()
      .filter((e) => e.aggregateId === intentId);
    expect(entries.map((e) => [e.eventType, e.sequence])).toEqual([
      ['PaymentInitiated', 1],
      ['PaymentSucceeded', 2],
    ]);
    expect(entries[1].payload).toMatchObject({
      providerChargeRef: CHARGE_REF,
      amount: { amount: 25_000, currency: 'NGN' },
    });

    // The webhook inbox MUST have a row for this event — that's
    // the "repair source" the migration comment on the initial
    // schema promises. Without this assertion, a regression that
    // silently drops the inbox write would pass the test suite
    // and only surface months later when a SequenceGapError
    // fired and the repair path had nothing to read.
    const inboxRows = harness.inbox.getRecorded();
    expect(inboxRows).toHaveLength(1);
    expect(inboxRows[0]).toEqual({
      provider: 'paystack',
      eventId: 'evt_provider_123',
      eventType: 'CHARGE_SUCCEEDED',
    });
  });

  it('applying the same event twice does not double-write the inbox', async () => {
    // The inbox is idempotent on (provider, event_id) — a
    // redelivery that Defense 1 caught as DUPLICATE_IGNORED
    // must not produce a second row. (If it did, the inbox would
    // grow unboundedly for any noisy provider.)
    const { harness } = await makeHarness();
    unwrap(await harness.handler.execute(webhookEvent()));
    unwrap(await harness.handler.execute(webhookEvent()));
    expect(harness.inbox.getRecorded()).toHaveLength(1);
  });

  it('applies CHARGE_FAILED and journals the failure with its reason', async () => {
    const { harness, intentId } = await makeHarness();

    const result = unwrap(
      await harness.handler.execute(
        webhookEvent({
          type: 'CHARGE_FAILED',
          amountMinor: undefined,
          currency: undefined,
          failureReason: 'insufficient funds',
        }),
      ),
    );

    expect(result.outcome).toBe('APPLIED');
    const intent = await harness.intents.findById(intentId);
    expect(intent?.currentStatus).toBe('FAILED');
    const failure = harness.ledger
      .all()
      .find((e) => e.eventType === 'PaymentFailed');
    expect(failure?.payload).toMatchObject({ reason: 'insufficient funds' });
  });

  it('ignores exact redeliveries of an already-processed event id', async () => {
    const { harness } = await makeHarness();

    const first = unwrap(await harness.handler.execute(webhookEvent()));
    expect(first.outcome).toBe('APPLIED');

    const redelivery = unwrap(await harness.handler.execute(webhookEvent()));
    expect(redelivery.outcome).toBe('DUPLICATE_IGNORED');

    // Exactly one PaymentSucceeded in the journal, despite two deliveries.
    expect(
      harness.ledger.all().filter((e) => e.eventType === 'PaymentSucceeded'),
    ).toHaveLength(1);
  });

  it('absorbs a crash-window redelivery (transition done, marker lost) idempotently', async () => {
    const { harness, intentId } = await makeHarness();

    // First delivery commits the transition.
    expect((await harness.handler.execute(webhookEvent())).ok).toBe(true);

    // Simulate the crash window: forget the processed marker, then deliver
    // a NEW event id (fresh delivery, same outcome) for the same charge.
    harness.processed = new InMemoryProcessedWebhookStore();
    harness.inbox = new InMemoryWebhookInboxStore();
    const handler = new HandlePaymentWebhookUseCase({
      intents: harness.intents,
      ledger: new LedgerAppender(harness.ledger),
      processedWebhooks: harness.processed,
      webhookInbox: harness.inbox,
      unitOfWork: new InMemoryUnitOfWork(),
    });

    const result = unwrap(
      await handler.execute(
        webhookEvent({ eventId: 'evt_provider_123_redelivery' }),
      ),
    );
    expect(result.outcome).toBe('ALREADY_IN_TARGET_STATE');
    expect(
      harness.ledger.all().filter((e) => e.eventType === 'PaymentSucceeded'),
    ).toHaveLength(1);
    const intent = await harness.intents.findById(intentId);
    expect(intent?.currentStatus).toBe('SUCCEEDED');
  });

  it('rejects a late SUCCEEDED after FAILED as a genuine conflict', async () => {
    const { harness, intentId } = await makeHarness();
    unwrap(
      await harness.handler.execute(
        webhookEvent({
          type: 'CHARGE_FAILED',
          amountMinor: undefined,
          currency: undefined,
        }),
      ),
    );

    const result = await harness.handler.execute(
      webhookEvent({ eventId: 'evt_late_success' }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBeInstanceOf(IllegalPaymentStatusTransitionError);
    }
    const intent = await harness.intents.findById(intentId);
    expect(intent?.currentStatus).toBe('FAILED');
  });

  it('rejects events referencing charges it has no intent for', async () => {
    const { harness } = await makeHarness();

    const result = await harness.handler.execute(
      webhookEvent({ providerRef: 'PAYSTACK-UNKNOWN-REF' }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBeInstanceOf(UnknownProviderReferenceError);
    }
  });

  it('rejects success events whose amount disagrees with the intent', async () => {
    const { harness } = await makeHarness();

    const result = await harness.handler.execute(
      webhookEvent({ amountMinor: 24_999 }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBeInstanceOf(WebhookAmountMismatchError);
    }
  });

  it('rejects known event types it does not handle (escrow-domain events)', async () => {
    const { harness } = await makeHarness();

    const result = await harness.handler.execute(
      webhookEvent({
        type: 'TRANSFER_COMPLETED',
        amountMinor: undefined,
        currency: undefined,
      }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBeInstanceOf(UnsupportedEventTypeError);
    }
  });
});
