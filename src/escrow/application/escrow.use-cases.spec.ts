import { LedgerAppender } from '../../ledger/application/ledger-appender';
import type { LedgerRepository } from '../../ledger/application/ports/ledger-repository';
import type { LedgerEntry } from '../../ledger/domain/ledger-entry';
import { assertNextSequence } from '../../ledger/domain/sequence';
import type { DomainError } from '../../shared/kernel/domain-error';
import type { Result } from '../../shared/kernel/result';
import type { SqlExecutor } from '../../shared/infrastructure/db';
import { optimisticSave } from '../../shared/infrastructure/in-memory-cas';
import { UnitOfWork } from '../../shared/infrastructure/unit-of-work';
import type { Pool } from 'pg';
import type { IdempotencyKey } from '../../shared/kernel/idempotency-key';
import type { IdempotencyStore } from '../../payments/application/ports/idempotency-store';
import { RequestInProgressError } from '../../payments/application/errors';
import type { Escrow } from '../domain/escrow';
import {
  PlaceEscrowHoldUseCase,
  type PlaceEscrowHoldCommand,
} from './place-escrow-hold.use-case';
import {
  ReleaseEscrowUseCase,
  type ReleaseEscrowCommand,
} from './release-escrow.use-case';
import { RefundEscrowUseCase } from './refund-escrow.use-case';
import { DisputeEscrowUseCase } from './dispute-escrow.use-case';
import { ResolveDisputeUseCase } from './resolve-dispute.use-case';
import { CancelEscrowUseCase } from './cancel-escrow.use-case';
import { ConfirmEscrowHoldUseCase } from './confirm-escrow-hold.use-case';
import type { EscrowRepository } from './ports/escrow.repository';
import type { SettledPaymentQuery } from './ports/settled-payment.query';
import {
  DuplicateEscrowForPaymentError,
  EscrowNotFoundError,
  PaymentNotSettledError,
} from './errors';

// --------------------------------------------------------------------- //
// In-memory fakes, mirroring the port contracts (same role as the fakes   //
// in the Payments specs).                                                 //
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

class InMemoryEscrowRepository implements EscrowRepository {
  private escrows = new Map<string, Escrow>();

  save(escrow: Escrow): Promise<void> {
    optimisticSave(this.escrows, escrow, (e) => e.escrowId, 'Escrow');
    return Promise.resolve();
  }

  findById(escrowId: string): Promise<Escrow | null> {
    return Promise.resolve(this.escrows.get(escrowId) ?? null);
  }

  findByPaymentIntentId(paymentIntentId: string): Promise<Escrow | null> {
    for (const escrow of this.escrows.values()) {
      if (escrow.paymentIntentId === paymentIntentId)
        return Promise.resolve(escrow);
    }
    return Promise.resolve(null);
  }

  with(_tx: SqlExecutor): InMemoryEscrowRepository {
    void _tx;
    return this;
  }
}

class SettableSettledPaymentQuery implements SettledPaymentQuery {
  readonly settled = new Set<string>();

  /** Test convenience: mark a payment intent as settled. */
  settle(paymentIntentId: string): void {
    this.settled.add(paymentIntentId);
  }

  isSettled(paymentIntentId: string): Promise<boolean> {
    return Promise.resolve(this.settled.has(paymentIntentId));
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

/** Noop unit-of-work — runs the callback with a stub tx. */
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

const INTENT_ID = '3fa85f64-5717-4562-b3fc-2c963f66afa6';

interface Harness {
  placeHold: PlaceEscrowHoldUseCase;
  release: ReleaseEscrowUseCase;
  refund: RefundEscrowUseCase;
  dispute: DisputeEscrowUseCase;
  resolveDispute: ResolveDisputeUseCase;
  cancel: CancelEscrowUseCase;
  confirm: ConfirmEscrowHoldUseCase;
  escrows: InMemoryEscrowRepository;
  ledger: InMemoryLedgerRepository;
  settled: SettableSettledPaymentQuery;
}

function makeHarness(): Harness {
  const escrows = new InMemoryEscrowRepository();
  const ledger = new InMemoryLedgerRepository();
  const idempotency = new InMemoryIdempotencyStore();
  const settled = new SettableSettledPaymentQuery();
  const appender = new LedgerAppender(ledger);
  const unitOfWork = new InMemoryUnitOfWork();
  return {
    placeHold: new PlaceEscrowHoldUseCase({
      idempotency,
      escrows,
      ledger: appender,
      settledPayments: settled,
      unitOfWork,
    }),
    release: new ReleaseEscrowUseCase({
      idempotency,
      escrows,
      ledger: appender,
      unitOfWork,
    }),
    refund: new RefundEscrowUseCase({
      idempotency,
      escrows,
      ledger: appender,
      unitOfWork,
    }),
    dispute: new DisputeEscrowUseCase({
      idempotency,
      escrows,
      ledger: appender,
      unitOfWork,
    }),
    resolveDispute: new ResolveDisputeUseCase({
      idempotency,
      escrows,
      ledger: appender,
      unitOfWork,
    }),
    cancel: new CancelEscrowUseCase({
      idempotency,
      escrows,
      ledger: appender,
      unitOfWork,
    }),
    confirm: new ConfirmEscrowHoldUseCase({
      escrows,
      ledger: appender,
      unitOfWork,
    }),
    escrows,
    ledger,
    settled,
  };
}

function holdCommand(
  overrides: Partial<PlaceEscrowHoldCommand> = {},
): PlaceEscrowHoldCommand {
  return {
    paymentIntentId: INTENT_ID,
    amountMinor: 10_000,
    currency: 'NGN',
    provider: 'paystack',
    idempotencyKey: 'escrow-order-000042',
    ...overrides,
  };
}

function unwrap<T>(result: Result<T, DomainError>): T {
  if (!result.ok) throw new Error(`expected success, got ${result.error.code}`);
  return result.value;
}

/** Registers + confirms a hold so release tests start from a HELD escrow. */
async function heldEscrow(h: Harness): Promise<{ escrowId: string }> {
  h.settled.settle(INTENT_ID);
  const placed = unwrap(await h.placeHold.execute(holdCommand()));
  const confirmed = unwrap(
    await h.confirm.execute({
      paymentIntentId: INTENT_ID,
      providerCustodyRef: 'PAYSTACK-SUBACCT-1',
    }),
  );
  if (confirmed.outcome !== 'HELD') throw new Error('fixture confirm failed');
  return { escrowId: placed.escrowId };
}

// --------------------------------------------------------------------- //
// Tests: PlaceEscrowHold                                                  //
// --------------------------------------------------------------------- //

describe('PlaceEscrowHoldUseCase', () => {
  it('places a hold over a settled payment and journals EscrowInitiated', async () => {
    const h = makeHarness();
    h.settled.settle(INTENT_ID);

    const result = unwrap(await h.placeHold.execute(holdCommand()));

    expect(result.state).toBe('PENDING');
    expect(result.provider).toBe('paystack');
    const escrow = await h.escrows.findById(result.escrowId);
    expect(escrow?.currentState).toBe('PENDING');

    const entries = h.ledger.all();
    expect(entries).toHaveLength(1);
    expect(entries[0].eventType).toBe('EscrowInitiated');
    expect(entries[0].sequence).toBe(1);
    expect(entries[0].payload).toMatchObject({
      paymentIntentId: INTENT_ID,
      heldAmount: { amount: 10_000, currency: 'NGN' },
    });
  });

  it('rejects holds over unsettled payments, releasing the key', async () => {
    const h = makeHarness();

    const result = await h.placeHold.execute(holdCommand());
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBeInstanceOf(PaymentNotSettledError);

    // Key was released: settling afterwards with the same key must succeed.
    h.settled.settle(INTENT_ID);
    const retry = unwrap(await h.placeHold.execute(holdCommand()));
    expect(retry.state).toBe('PENDING');
  });

  it('rejects a second escrow for the same payment intent', async () => {
    const h = makeHarness();
    h.settled.settle(INTENT_ID);
    unwrap(await h.placeHold.execute(holdCommand()));

    const duplicate = await h.placeHold.execute(
      holdCommand({ idempotencyKey: 'escrow-order-000099' }),
    );
    expect(duplicate.ok).toBe(false);
    if (!duplicate.ok) {
      expect(duplicate.error).toBeInstanceOf(DuplicateEscrowForPaymentError);
    }
  });

  it('replays a completed key without re-executing', async () => {
    const h = makeHarness();
    h.settled.settle(INTENT_ID);

    const first = unwrap(await h.placeHold.execute(holdCommand()));
    const second = unwrap(await h.placeHold.execute(holdCommand()));

    expect(second).toEqual(first);
    expect(h.ledger.all()).toHaveLength(1);
  });
});

// --------------------------------------------------------------------- //
// Tests: ConfirmEscrowHold                                                //
// --------------------------------------------------------------------- //

describe('ConfirmEscrowHoldUseCase', () => {
  it('moves PENDING → HELD and journals EscrowHeld', async () => {
    const h = makeHarness();
    const { escrowId } = await heldEscrow(h);

    const escrow = await h.escrows.findById(escrowId);
    expect(escrow?.currentState).toBe('HELD');
    expect(escrow?.custodyReference).toBe('PAYSTACK-SUBACCT-1');

    const entries = h.ledger.all().filter((e) => e.aggregateId === escrowId);
    expect(entries.map((e) => [e.eventType, e.sequence])).toEqual([
      ['EscrowInitiated', 1],
      ['EscrowHeld', 2],
    ]);
  });

  it('absorbs a redelivery on an already-held escrow (crash window)', async () => {
    const h = makeHarness();
    const { escrowId } = await heldEscrow(h);

    const again = unwrap(
      await h.confirm.execute({
        paymentIntentId: INTENT_ID,
        providerCustodyRef: 'PAYSTACK-SUBACCT-1',
      }),
    );
    expect(again).toEqual({ outcome: 'ALREADY_HELD', escrowId });
    expect(
      h.ledger.all().filter((e) => e.eventType === 'EscrowHeld'),
    ).toHaveLength(1);
  });

  it('returns NO_ESCROW_FOR_PAYMENT for settled payments without a hold', async () => {
    const h = makeHarness();
    const result = unwrap(
      await h.confirm.execute({
        paymentIntentId: INTENT_ID,
        providerCustodyRef: 'ANY',
      }),
    );
    expect(result.outcome).toBe('NO_ESCROW_FOR_PAYMENT');
  });
});

// --------------------------------------------------------------------- //
// Tests: ReleaseEscrow                                                    //
// --------------------------------------------------------------------- //

describe('ReleaseEscrowUseCase', () => {
  it('partially releases and reports running totals', async () => {
    const h = makeHarness();
    const { escrowId } = await heldEscrow(h);

    const result = unwrap(
      await h.release.execute({
        escrowId,
        amountMinor: 7_000,
        currency: 'NGN',
        idempotencyKey: 'release-000042-1',
        recipientRef: 'seller-subacct-9',
      } satisfies ReleaseEscrowCommand),
    );

    expect(result.state).toBe('HELD');
    expect(result.releasedToDate).toEqual({ amount: 7_000, currency: 'NGN' });
    expect(result.availableAmount).toEqual({ amount: 3_000, currency: 'NGN' });

    const entries = h.ledger.all().filter((e) => e.aggregateId === escrowId);
    expect(entries.map((e) => e.eventType)).toEqual([
      'EscrowInitiated',
      'EscrowHeld',
      'EscrowReleased',
    ]);
    expect(entries[2].payload).toMatchObject({
      amount: { amount: 7_000, currency: 'NGN' },
      releasedToDate: { amount: 7_000, currency: 'NGN' },
      recipientRef: 'seller-subacct-9',
    });
  });

  it('full release closes the escrow as RELEASED', async () => {
    const h = makeHarness();
    const { escrowId } = await heldEscrow(h);

    const result = unwrap(
      await h.release.execute({
        escrowId,
        amountMinor: 10_000,
        currency: 'NGN',
        idempotencyKey: 'release-000042-full',
      }),
    );
    expect(result.state).toBe('RELEASED');
  });

  it('surfaces domain violations: over-release, wrong currency, unknown escrow', async () => {
    const h = makeHarness();
    const { escrowId } = await heldEscrow(h);

    const over = await h.release.execute({
      escrowId,
      amountMinor: 10_001,
      currency: 'NGN',
      idempotencyKey: 'release-over',
    });
    expect(over.ok).toBe(false);

    const wrongCurrency = await h.release.execute({
      escrowId,
      amountMinor: 100,
      currency: 'USD',
      idempotencyKey: 'release-usd',
    });
    expect(wrongCurrency.ok).toBe(false);

    const unknown = await h.release.execute({
      escrowId: 'no-such-escrow',
      amountMinor: 100,
      currency: 'NGN',
      idempotencyKey: 'release-unknown',
    });
    expect(unknown.ok).toBe(false);
    if (!unknown.ok) expect(unknown.error).toBeInstanceOf(EscrowNotFoundError);
  });

  it('replays releases idempotently by key', async () => {
    const h = makeHarness();
    const { escrowId } = await heldEscrow(h);

    const command: ReleaseEscrowCommand = {
      escrowId,
      amountMinor: 2_000,
      currency: 'NGN',
      idempotencyKey: 'release-replay-1',
    };
    const first = unwrap(await h.release.execute(command));
    const second = unwrap(await h.release.execute(command));

    expect(second).toEqual(first);
    const escrow = await h.escrows.findById(escrowId);
    expect(escrow?.releasedToDate.amount).toBe(2_000); // applied once
  });

  it('rejects concurrent duplicate releases', async () => {
    const h = makeHarness();
    const { escrowId } = await heldEscrow(h);
    const key = 'release-concurrent' as IdempotencyKey;
    // Simulate another request holding the key.
    const store = new InMemoryIdempotencyStore();
    await store.acquire('escrow.release', key);

    const release = new ReleaseEscrowUseCase({
      idempotency: store,
      escrows: h.escrows,
      ledger: new LedgerAppender(h.ledger),
      unitOfWork: new InMemoryUnitOfWork(),
    });
    const result = await release.execute({
      escrowId,
      amountMinor: 1_000,
      currency: 'NGN',
      idempotencyKey: key,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBeInstanceOf(RequestInProgressError);
  });
});

describe('RefundEscrowUseCase', () => {
  it('partially refunds and reports running totals', async () => {
    const h = makeHarness();
    const { escrowId } = await heldEscrow(h);
    const result = unwrap(
      await h.refund.execute({
        escrowId,
        amountMinor: 3_000,
        currency: 'NGN',
        idempotencyKey: 'refund-000001',
      }),
    );
    expect(result.state).toBe('HELD');
    expect(result.refundedToDate).toEqual({ amount: 3_000, currency: 'NGN' });
    expect(result.availableAmount).toEqual({ amount: 7_000, currency: 'NGN' });
    const events = h.ledger.all().filter((e) => e.aggregateId === escrowId);
    expect(events.map((e) => e.eventType)).toContain('EscrowRefunded');
  });

  it('rejects over-refund (sum > held)', async () => {
    const h = makeHarness();
    const { escrowId } = await heldEscrow(h);
    const over = await h.refund.execute({
      escrowId,
      amountMinor: 10_001,
      currency: 'NGN',
      idempotencyKey: 'refund-over',
    });
    expect(over.ok).toBe(false);
  });
});

describe('DisputeEscrowUseCase', () => {
  it('transitions HELD → DISPUTED and journals EscrowDisputed', async () => {
    const h = makeHarness();
    const { escrowId } = await heldEscrow(h);
    const result = unwrap(
      await h.dispute.execute({
        escrowId,
        idempotencyKey: 'dispute-000001',
        reason: 'buyer claims non-delivery',
      }),
    );
    expect(result.state).toBe('DISPUTED');
    const events = h.ledger.all().filter((e) => e.aggregateId === escrowId);
    expect(events.map((e) => e.eventType)).toContain('EscrowDisputed');
  });

  it('refuses to dispute a PENDING escrow (no funds to freeze)', async () => {
    const h = makeHarness();
    // Don't hold first — escrow is still PENDING.
    h.settled.settle(INTENT_ID);
    const placed = unwrap(
      await h.placeHold.execute(
        holdCommand({ idempotencyKey: 'place-for-pending' }),
      ),
    );
    const result = await h.dispute.execute({
      escrowId: placed.escrowId,
      idempotencyKey: 'dispute-pending',
      reason: 'test',
    });
    expect(result.ok).toBe(false);
  });
});

describe('ResolveDisputeUseCase', () => {
  it('transitions DISPUTED → HELD', async () => {
    const h = makeHarness();
    const { escrowId } = await heldEscrow(h);
    await h.dispute.execute({
      escrowId,
      idempotencyKey: 'dispute-for-resolve',
      reason: 'test',
    });
    const result = unwrap(
      await h.resolveDispute.execute({
        escrowId,
        idempotencyKey: 'resolve-000001',
      }),
    );
    expect(result.state).toBe('HELD');
    const events = h.ledger.all().filter((e) => e.aggregateId === escrowId);
    expect(events.map((e) => e.eventType)).toContain('EscrowResolved');
  });
});

describe('CancelEscrowUseCase', () => {
  it('cancels a PENDING escrow and journals EscrowCancelled', async () => {
    const h = makeHarness();
    h.settled.settle(INTENT_ID);
    const placed = unwrap(
      await h.placeHold.execute(
        holdCommand({ idempotencyKey: 'place-for-cancel' }),
      ),
    );
    const result = unwrap(
      await h.cancel.execute({
        escrowId: placed.escrowId,
        idempotencyKey: 'cancel-000001',
        reason: 'merchant abandoned checkout',
      }),
    );
    expect(result.state).toBe('CANCELLED');
    const events = h.ledger
      .all()
      .filter((e) => e.aggregateId === placed.escrowId);
    expect(events.map((e) => e.eventType)).toContain('EscrowCancelled');
  });

  it('refuses to cancel a HELD escrow (funds are real)', async () => {
    const h = makeHarness();
    const { escrowId } = await heldEscrow(h);
    const result = await h.cancel.execute({
      escrowId,
      idempotencyKey: 'cancel-held',
      reason: 'test',
    });
    expect(result.ok).toBe(false);
  });
});
