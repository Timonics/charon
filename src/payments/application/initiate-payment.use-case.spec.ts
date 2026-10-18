import { LedgerAppender } from '../../ledger/application/ledger-appender';
import type { LedgerRepository } from '../../ledger/application/ports/ledger-repository';
import type { LedgerEntry } from '../../ledger/domain/ledger-entry';
import { assertNextSequence } from '../../ledger/domain/sequence';
import type { IdempotencyKey } from '../../shared/kernel/idempotency-key';
import type { DomainError } from '../../shared/kernel/domain-error';
import type { ProviderName } from '../../shared/kernel/provider-name';
import type { Pool } from 'pg';
import type { SqlExecutor } from '../../shared/infrastructure/db';
import { optimisticSave } from '../../shared/infrastructure/in-memory-cas';
import { UnitOfWork } from '../../shared/infrastructure/unit-of-work';
import { err, ok, type Result } from '../../shared/kernel/result';
import { RoutingFailedError } from '../domain/errors';
import type { PaymentIntent } from '../domain/payment-intent';
import type { IdempotencyStore } from './ports/idempotency-store';
import type { PaymentIntentRepository } from './ports/payment-intent.repository';
import type {
  PaymentGatewayPort,
  InitializedCharge,
  InitializeChargeInput,
} from '../../provider-integration/application/ports/payment-gateway.port';
import { InitiatePaymentUseCase } from './initiate-payment.use-case';
import {
  type InitiatePaymentCommand,
  type InitiatePaymentResult,
} from './initiate-payment.use-case';
import { RequestInProgressError } from './errors';

/**
 * In-memory {@link PaymentGatewayPort} for use-case tests.
 * Returns the input `reference` as `providerReference` (matches
 * Paystack's contract) and records every call so specs can
 * assert on inputs. Override the result via `setNext` or
 * `setPersistentFailure` to exercise failure paths.
 *
 * Lives in the spec file (not a shared test-helpers module)
 * because the existing codebase pattern inlines fakes per
 * spec. The class is small; the duplication is bounded to
 * `handle-payment-webhook.use-case.spec.ts`,
 * `unit-of-work-atomicity.spec.ts`, and the payments integration
 * spec, where the same minimal fake is repeated.
 */
import { rehydrateTenantId, type Principal } from '../../shared/kernel/tenant';

/**
 * The single test principal used across this spec. The
 * InitiatePayment use case reads `principal.tenantId` and stamps
 * it onto the freshly-created intent. Production code in PR-NN2
 * will read the verified JWT's `org` claim and build the real
 * Principal at the HTTP boundary.
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
  readonly provider: ProviderName;
  readonly calls: InitializeChargeInput[] = [];
  private next: Result<InitializedCharge, DomainError> | null = null;
  private persistent: DomainError | null = null;

  constructor(provider: ProviderName = 'paystack') {
    this.provider = provider;
  }

  setNext(result: Result<InitializedCharge, DomainError>): void {
    this.next = result;
  }

  setPersistentFailure(error: DomainError): void {
    this.persistent = error;
  }

  async initializeCharge(
    input: InitializeChargeInput,
  ): Promise<Result<InitializedCharge, DomainError>> {
    await Promise.resolve();
    this.calls.push(input);
    if (this.persistent) return err(this.persistent);
    if (this.next) {
      const r = this.next;
      this.next = null;
      return r;
    }
    return ok({
      providerReference: input.reference,
      checkoutUrl: 'https://checkout.test/inmem',
      raw: { testEcho: true, sentAmountMinor: input.amountMinor },
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

// --------------------------------------------------------------------- //
// In-memory fakes. These are the contract tests for the ports: if the     //
// real Postgres adapters ever behave differently from these fakes, the    //
// use case breaks in production in ways the unit tests cannot see. The    //
// fake behavior is therefore written to mirror the port doc comments      //
// exactly (atomic append, sequence continuity, acquire semantics).        //
// --------------------------------------------------------------------- //

class InMemoryIdempotencyStore implements IdempotencyStore {
  private states = new Map<
    string,
    { state: 'in-progress' } | { state: 'completed'; result: unknown }
  >();

  private keyOf(scope: string, key: IdempotencyKey): string {
    return `${scope}:${key}`;
  }

  // Non-async bodies returning Promise.resolve(...): the PORT is async
  // because real implementations do I/O, but these fakes are synchronous;
  // spelling it out keeps honest types without `require-await` suppressions.
  getCompleted<T>(scope: string, key: IdempotencyKey): Promise<T | null> {
    const record = this.states.get(this.keyOf(scope, key));
    return Promise.resolve(
      record?.state === 'completed' ? (record.result as T) : null,
    );
  }

  acquire(
    scope: string,
    key: IdempotencyKey,
  ): Promise<'acquired' | 'in-progress'> {
    const keyOf = this.keyOf(scope, key);
    if (this.states.has(keyOf)) return Promise.resolve('in-progress');
    this.states.set(keyOf, { state: 'in-progress' });
    return Promise.resolve('acquired');
  }

  complete(scope: string, key: IdempotencyKey, result: unknown): Promise<void> {
    this.states.set(this.keyOf(scope, key), { state: 'completed', result });
    return Promise.resolve();
  }

  release(scope: string, key: IdempotencyKey): Promise<void> {
    this.states.delete(this.keyOf(scope, key));
    return Promise.resolve();
  }

  /**
   * In-memory passthrough — every "transaction" is the shared state, so
   * `with()` returns `this`. Production Postgres returns a fresh store
   * bound to a transaction client; the in-memory equivalent is "the same
   * store, because the backing map is process-global". The point of
   * implementing `with()` here is so use-case code can call
   * `idempotency.with(tx)` inside a unit-of-work without special-casing.
   */
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

  /** In-memory passthrough — shared map, so `with()` returns self. */
  with(_tx: SqlExecutor): InMemoryPaymentIntentRepository {
    void _tx;
    return this;
  }

  get size(): number {
    return this.intents.size;
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

  /** In-memory passthrough — shared array, so `with()` returns self. */
  with(_tx: SqlExecutor): InMemoryLedgerRepository {
    void _tx;
    return this;
  }
}

// --------------------------------------------------------------------- //
// Fixture wiring                                                          //
// --------------------------------------------------------------------- //

function makeCommand(
  overrides: Partial<InitiatePaymentCommand> = {},
): InitiatePaymentCommand {
  return {
    amountMinor: 25_000,
    currency: 'NGN',
    method: 'card',
    idempotencyKey: 'charge-order-000042',
    ...overrides,
  };
}

interface Harness {
  useCase: InitiatePaymentUseCase;
  intents: InMemoryPaymentIntentRepository;
  ledger: InMemoryLedgerRepository;
  idempotency: InMemoryIdempotencyStore;
  gateways: RecordingGatewayAdapter;
}

function makeHarness(): Harness {
  const intents = new InMemoryPaymentIntentRepository();
  const ledger = new InMemoryLedgerRepository();
  const idempotency = new InMemoryIdempotencyStore();
  // The test exercises routing across the three providers in
  // DEFAULT_ROUTING_RULES. Bind a gateway for each so routing
  // failures (a) surface as RoutingFailedError, not as the
  // missing-gateway path, and (b) the retry path can actually
  // call a different provider.
  const gateways = new RecordingGatewayAdapter();
  const gateways2 = new RecordingGatewayAdapter('flutterwave');
  const gateways3 = new RecordingGatewayAdapter('stripe');
  const useCase = new InitiatePaymentUseCase({
    principal: TEST_PRINCIPAL,
    idempotency,
    intents,
    ledger: new LedgerAppender(ledger),
    gateways: gatewayMap([gateways, gateways2, gateways3]),
    unitOfWork: new InMemoryUnitOfWork(),
  });
  return { useCase, intents, ledger, idempotency, gateways };
}

/**
 * The noop unit-of-work — just runs the callback. The in-memory fakes all
 * commit-or-noop atomically per call, so wrapping the work in a real
 * transaction adds no observable behavior here. The transactional tests
 * for this use case live in {@link InitiatePaymentUseCase.transactional}
 * below and use the real `UnitOfWork` + `TransactionalSqlExecutor` pair.
 */
class InMemoryUnitOfWork extends UnitOfWork {
  // Pass a stub pool to the parent — we never call .connect() because
  // run() is overridden. The pool is required by the UnitOfWork
  // constructor signature but is unreachable in this subclass.
  constructor() {
    super({} as Pool);
  }
  async run<T>(work: (tx: SqlExecutor) => Promise<T>): Promise<T> {
    // The tx argument is not used by the in-memory fakes (their `with()`
    // ignores it), so any object satisfies the type. Pass an empty stub.
    return work({} as SqlExecutor);
  }
}

function unwrap(
  result:
    | { ok: true; value: InitiatePaymentResult }
    | { ok: false; error: DomainError },
): InitiatePaymentResult {
  if (!result.ok) throw new Error(`expected success, got ${result.error.code}`);
  return result.value;
}

// --------------------------------------------------------------------- //
// Tests                                                                   //
// --------------------------------------------------------------------- //

describe('InitiatePaymentUseCase', () => {
  it('creates an intent, journals PaymentInitiated, and completes the key', async () => {
    const { useCase, intents, ledger } = makeHarness();

    const result = unwrap(await useCase.execute(makeCommand()));

    expect(result.status).toBe('PROCESSING');
    expect(result.provider).toBe('paystack');
    expect(result.amountMinor).toBe(25_000);
    expect(result.providerReference).toBeTruthy();
    expect(intents.size).toBe(1);

    const entries = ledger.all();
    expect(entries).toHaveLength(1);
    expect(entries[0].eventType).toBe('PaymentInitiated');
    expect(entries[0].sequence).toBe(1);
    expect(entries[0].payload).toMatchObject({
      amount: { amount: 25_000, currency: 'NGN' },
      method: 'card',
      provider: 'paystack',
      idempotencyKey: 'charge-order-000042',
    });
  });

  it('replays a completed key without re-executing (idempotency)', async () => {
    const { useCase, intents, ledger } = makeHarness();
    const command = makeCommand();

    const first = unwrap(await useCase.execute(command));
    const second = unwrap(await useCase.execute(command));

    expect(second).toEqual(first);
    expect(intents.size).toBe(1);
    expect(ledger.all()).toHaveLength(1);
  });

  it('rejects a concurrent duplicate while the original is in progress', async () => {
    const idempotency = new InMemoryIdempotencyStore();
    await idempotency.acquire(
      'payments.initiate',
      'charge-order-000042' as IdempotencyKey,
    );

    const useCase = new InitiatePaymentUseCase({
      principal: TEST_PRINCIPAL,
      idempotency,
      intents: new InMemoryPaymentIntentRepository(),
      ledger: new LedgerAppender(new InMemoryLedgerRepository()),
      gateways: gatewayMap([new RecordingGatewayAdapter()]),
      unitOfWork: new InMemoryUnitOfWork(),
    });

    const result = await useCase.execute(makeCommand());
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBeInstanceOf(RequestInProgressError);
    }
  });

  it.each([
    ['bad idempotency key', { idempotencyKey: 'x' }],
    ['bad method', { method: 'cash' }],
    ['bad currency', { currency: 'XXX' }],
    ['fractional amount', { amountMinor: 100.5 }],
  ])(
    'fails validation before touching state: %s',
    async (_label, overrides) => {
      const { useCase, intents, ledger, idempotency } = makeHarness();

      const result = await useCase.execute(makeCommand(overrides));
      expect(result.ok).toBe(false);
      expect(intents.size).toBe(0);
      expect(ledger.all()).toHaveLength(0);
      // The key must be usable afterwards — validation failures must not pin it.
      const retry = await useCase.execute(makeCommand());
      expect(retry.ok).toBe(true);
      void idempotency;
    },
  );

  it('releases the key when routing fails, so the caller can retry differently', async () => {
    const { useCase, intents } = makeHarness();

    const result = await useCase.execute(
      makeCommand({ currency: 'USD', method: 'ussd' }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBeInstanceOf(RoutingFailedError);
    }
    expect(intents.size).toBe(0);

    // Same key, corrected method: must execute (released, not completed).
    const retry = unwrap(
      await useCase.execute(
        makeCommand({
          currency: 'USD',
          method: 'card',
          idempotencyKey: 'charge-order-000042',
        }),
      ),
    );
    expect(retry.provider).toBe('stripe');
  });

  it('assigns independent sequences per aggregate', async () => {
    const { useCase, ledger } = makeHarness();

    const first = unwrap(await useCase.execute(makeCommand()));
    const second = unwrap(
      await useCase.execute(
        makeCommand({ idempotencyKey: 'charge-order-000043' }),
      ),
    );

    const entries = ledger.all();
    const forFirst = entries.filter((e) => e.aggregateId === first.intentId);
    const forSecond = entries.filter((e) => e.aggregateId === second.intentId);
    expect(forFirst.map((e) => e.sequence)).toEqual([1]);
    expect(forSecond.map((e) => e.sequence)).toEqual([1]);
  });
});
