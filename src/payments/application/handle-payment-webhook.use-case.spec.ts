import { LedgerAppender } from '../../ledger/application/ledger-appender';
import type { LedgerRepository } from '../../ledger/application/ports/ledger-repository';
import type { LedgerEntry } from '../../ledger/domain/ledger-entry';
import { assertNextSequence } from '../../ledger/domain/sequence';
import { NormalizedPaymentEvent } from '../../provider-integration/domain/normalized-payment-event';
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
  const unitOfWork = new InMemoryUnitOfWork();

  const initiate = new InitiatePaymentUseCase({
    idempotency: new InMemoryIdempotencyStore(),
    intents,
    ledger: new LedgerAppender(ledger),
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

  // Simulate the provider accepting the charge (normally the adapter's job
  // once PaymentProviderPort is wired).
  const intent = await intents.findById(intentId);
  if (!intent) throw new Error('fixture intent missing');
  intent.markProcessing(CHARGE_REF);
  await intents.save(intent);

  const handler = new HandlePaymentWebhookUseCase({
    intents,
    ledger: new LedgerAppender(ledger),
    processedWebhooks: processed,
    unitOfWork,
  });
  return { harness: { handler, intents, ledger, processed }, intentId };
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
    const handler = new HandlePaymentWebhookUseCase({
      intents: harness.intents,
      ledger: new LedgerAppender(harness.ledger),
      processedWebhooks: harness.processed,
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
