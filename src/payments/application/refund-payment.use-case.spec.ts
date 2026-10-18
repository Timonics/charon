import { LedgerAppender } from '../../ledger/application/ledger-appender';
import type { LedgerRepository } from '../../ledger/application/ports/ledger-repository';
import type { LedgerEntry } from '../../ledger/domain/ledger-entry';
import type { IdempotencyKey } from '../../shared/kernel/idempotency-key';
import type { DomainError } from '../../shared/kernel/domain-error';
import type { ProviderName } from '../../shared/kernel/provider-name';
import { Money } from '../../shared/kernel/money';
import { rehydrateTenantId } from '../../shared/kernel/tenant';
import type { Pool } from 'pg';
import type { SqlExecutor } from '../../shared/infrastructure/db';
import { optimisticSave } from '../../shared/infrastructure/in-memory-cas';
import { UnitOfWork } from '../../shared/infrastructure/unit-of-work';
import { PaymentIntent } from '../domain/payment-intent';
import { parseIdempotencyKey } from '../../shared/kernel/idempotency-key';
import type { IdempotencyStore } from './ports/idempotency-store';
import type { PaymentIntentRepository } from './ports/payment-intent.repository';
import {
  RefundPaymentUseCase,
  type RefundPaymentCommand,
  type RefundPaymentResult,
} from './refund-payment.use-case';

// In-memory fakes — same shape as the other payments specs.

class InMemoryIdempotencyStore implements IdempotencyStore {
  private states = new Map<
    string,
    { state: 'in-progress' } | { state: 'completed'; result: unknown }
  >();
  private keyOf(scope: string, key: IdempotencyKey): string {
    return `${scope}:${key}`;
  }
  getCompleted<T>(scope: string, key: IdempotencyKey): Promise<T | null> {
    const r = this.states.get(this.keyOf(scope, key));
    return Promise.resolve(r?.state === 'completed' ? (r.result as T) : null);
  }
  acquire(
    scope: string,
    key: IdempotencyKey,
  ): Promise<'acquired' | 'in-progress'> {
    const k = this.keyOf(scope, key);
    if (this.states.has(k)) return Promise.resolve('in-progress');
    this.states.set(k, { state: 'in-progress' });
    return Promise.resolve('acquired');
  }
  complete<T>(scope: string, key: IdempotencyKey, result: T): Promise<void> {
    this.states.set(this.keyOf(scope, key), { state: 'completed', result });
    return Promise.resolve();
  }
  release(scope: string, key: IdempotencyKey): Promise<void> {
    this.states.delete(this.keyOf(scope, key));
    return Promise.resolve();
  }
  with(_tx: SqlExecutor): InMemoryIdempotencyStore {
    void _tx;
    return this;
  }
}

class InMemoryPaymentIntentRepository implements PaymentIntentRepository {
  private intents = new Map<string, PaymentIntent>();
  /** Mirror of the private providerChargeRef; needed for findByProviderChargeRef. */
  private chargeRefs = new Map<string, string>();
  save(intent: PaymentIntent): Promise<void> {
    optimisticSave(this.intents, intent, (i) => i.intentId, 'PaymentIntent');
    const chargeRef = intent.toSnapshot().providerChargeRef;
    if (chargeRef) {
      this.chargeRefs.set(chargeRef, intent.intentId);
    }
    return Promise.resolve();
  }
  findById(id: string): Promise<PaymentIntent | null> {
    return Promise.resolve(this.intents.get(id) ?? null);
  }
  findByIdempotencyKey(key: IdempotencyKey): Promise<PaymentIntent | null> {
    for (const i of this.intents.values()) {
      if (i.idempotencyKey === key) return Promise.resolve(i);
    }
    return Promise.resolve(null);
  }
  findByProviderChargeRef(
    p: ProviderName,
    r: string,
  ): Promise<PaymentIntent | null> {
    const id = this.chargeRefs.get(r);
    if (!id) return Promise.resolve(null);
    const intent = this.intents.get(id);
    if (!intent || intent.provider !== p) return Promise.resolve(null);
    return Promise.resolve(intent);
  }
  with(_tx: SqlExecutor): InMemoryPaymentIntentRepository {
    void _tx;
    return this;
  }
}

class InMemoryLedgerRepository implements LedgerRepository {
  private entries: LedgerEntry[] = [];
  append(entries: readonly LedgerEntry[]): Promise<void> {
    for (const e of entries) this.entries.push(e);
    return Promise.resolve();
  }
  lastSequence(aggregateId: string): Promise<number | undefined> {
    const matching = this.entries.filter((e) => e.aggregateId === aggregateId);
    if (matching.length === 0) return Promise.resolve(undefined);
    return Promise.resolve(Math.max(...matching.map((e) => e.sequence)));
  }
  all(): readonly LedgerEntry[] {
    return this.entries;
  }
  with(_tx: SqlExecutor): InMemoryLedgerRepository {
    void _tx;
    return this;
  }
}

class InMemoryUnitOfWork extends UnitOfWork {
  constructor() {
    super({} as Pool);
  }
  async run<T>(work: (tx: SqlExecutor) => Promise<T>): Promise<T> {
    return work({} as SqlExecutor);
  }
}

function unwrap(
  r:
    | { ok: true; value: RefundPaymentResult }
    | { ok: false; error: DomainError },
): RefundPaymentResult {
  if (!r.ok) throw new Error(`expected ok, got ${r.error.code}`);
  return r.value;
}

/** Throws if the key is invalid — test inputs are static so this is OK. */
function parseKeyOrFallback(s: string): IdempotencyKey {
  const r = parseIdempotencyKey(s);
  if (!r.ok) throw new Error(`test key ${s} failed to parse: ${r.error.code}`);
  return r.value;
}

/**
 * The single test tenant used in this spec. The refund use case
 * does not yet read `principal.tenantId` (deferred to PR-NN2),
 * but the aggregate's `tenantId` field is required, so the
 function parseKeyOrFallback(s: string): IdempotencyKey {
   const r = parseIdempotencyKey(s);
   if (!r.ok) throw new Error(`test key ${s} failed to parse: ${r.error.code}`);
   return r.value;
 }

 /**
  * The single test tenant used in this spec. The refund use case
  * does not yet read `principal.tenantId` (deferred to PR-NN2),
  * but the aggregate's `tenantId` field is required, so the
  * fixture must stamp a known value.
  */
const TEST_TENANT = rehydrateTenantId('a1b2c3d4-1111-4222-8333-444444444444');

function succeededIntent(id: string): PaymentIntent {
  const intent = PaymentIntent.create({
    tenantId: TEST_TENANT,
    amount: Money.of(40_000, 'NGN'),
    method: 'card',
    provider: 'paystack',
    idempotencyKey: parseKeyOrFallback(`init-${id}-key`),
  });
  intent.markProcessing('PSK-CHARGE-REF-1');
  intent.markSucceeded();
  return intent;
}

describe('RefundPaymentUseCase', () => {
  function makeFixture() {
    const intents = new InMemoryPaymentIntentRepository();
    const ledger = new InMemoryLedgerRepository();
    const idempotency = new InMemoryIdempotencyStore();
    const unitOfWork = new InMemoryUnitOfWork();
    const useCase = new RefundPaymentUseCase({
      intents,
      idempotency,
      ledger: new LedgerAppender(ledger),
      unitOfWork,
    });
    return { intents, ledger, idempotency, unitOfWork, useCase };
  }

  it('partially refunds a SUCCEEDED intent and journals RefundIssued', async () => {
    const f = makeFixture();
    const intent = succeededIntent('a');
    await f.intents.save(intent);
    const result = unwrap(
      await f.useCase.execute({
        intentId: intent.intentId,
        amountMinor: 5_000,
        currency: 'NGN',
        idempotencyKey: 'refund-payment-1',
      } satisfies RefundPaymentCommand),
    );
    expect(result.status).toBe('SUCCEEDED');
    expect(result.refundedToDate).toEqual({ amount: 5_000, currency: 'NGN' });
    const events = f.ledger
      .all()
      .filter((e) => e.aggregateId === intent.intentId);
    expect(events.map((e) => e.eventType)).toContain('RefundIssued');
  });

  it('rejects refund of an INITIATED intent (only SUCCEEDED can be refunded)', async () => {
    const f = makeFixture();
    const intent = PaymentIntent.create({
      tenantId: TEST_TENANT,
      amount: Money.of(40_000, 'NGN'),
      method: 'card',
      provider: 'paystack',
      idempotencyKey: parseKeyOrFallback('init-b-key'),
    });
    await f.intents.save(intent);
    const result = await f.useCase.execute({
      intentId: intent.intentId,
      amountMinor: 1_000,
      currency: 'NGN',
      idempotencyKey: 'refund-payment-2',
    });
    expect(result.ok).toBe(false);
  });
});
