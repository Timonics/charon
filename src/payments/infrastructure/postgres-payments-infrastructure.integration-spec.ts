import type { IdempotencyKey } from '../../shared/kernel/idempotency-key';
import { Money } from '../../shared/kernel/money';
import { InitiatePaymentUseCase } from '../application/initiate-payment.use-case';
import { PaymentIntent } from '../domain/payment-intent';
import { LedgerAppender } from '../../ledger/application/ledger-appender';
import { PostgresLedgerRepository } from '../../ledger/infrastructure/postgres-ledger.repository';
import { UnitOfWork } from '../../shared/infrastructure/unit-of-work';
import { PostgresIdempotencyStore } from './postgres-idempotency.store';
import { PostgresPaymentIntentRepository } from './postgres-payment-intent.repository';
import { PostgresProcessedWebhookStore } from './postgres-processed-webhook.store';
import { PostgresSettledPaymentQuery } from './postgres-settled-payment.query';
import {
  applyMigrations,
  closeIntegrationPool,
  integrationPool,
  truncateAll,
} from '../../../test/integration-setup';

const KEY = 'infra-test-key-0001' as IdempotencyKey;

function succeededIntent() {
  const intent = PaymentIntent.create({
    amount: Money.of(40_000, 'NGN'),
    method: 'card',
    provider: 'paystack',
    idempotencyKey: KEY,
  });
  intent.markProcessing('PSK-INFRA-REF-1');
  intent.markSucceeded();
  return intent;
}

describe('Postgres payments infrastructure (integration)', () => {
  const pool = integrationPool();

  beforeAll(() => applyMigrations());
  beforeEach(async () => truncateAll(pool));
  afterAll(async () => closeIntegrationPool());

  describe('PostgresPaymentIntentRepository', () => {
    const repo = () => new PostgresPaymentIntentRepository(pool);

    it('round-trips a snapshot, including charge ref and refunded totals', async () => {
      const intent = succeededIntent();
      intent.recordRefund(Money.of(5_000, 'NGN'));
      await repo().save(intent);

      const byId = await repo().findById(intent.intentId);
      expect(byId?.currentStatus).toBe('SUCCEEDED');
      expect(byId?.chargeReference).toBe('PSK-INFRA-REF-1');
      expect(byId?.refundedToDate.amount).toBe(5_000);
      expect(byId?.amount.amount).toBe(40_000);
      expect(byId?.amount.currency).toBe('NGN');

      const byRef = await repo().findByProviderChargeRef(
        'paystack',
        'PSK-INFRA-REF-1',
      );
      expect(byRef?.intentId).toBe(intent.intentId);

      expect(
        await repo().findById('00000000-0000-0000-0000-000000000000'),
      ).toBeNull();
    });

    it('upserts on repeated saves', async () => {
      const intent = succeededIntent();
      await repo().save(intent);
      // Re-saving the same snapshot is idempotent and must not duplicate.
      await repo().save(intent);
      const { rows } = await pool.query<{ n: number }>(
        'SELECT count(*)::int AS n FROM payment_intents',
      );
      expect(rows[0].n).toBe(1);
    });
  });

  describe('PostgresIdempotencyStore', () => {
    const store = () => new PostgresIdempotencyStore(pool);

    it('runs the acquire → complete → replay lifecycle', async () => {
      expect(await store().acquire('scope', KEY)).toBe('acquired');
      expect(await store().acquire('scope', KEY)).toBe('in-progress');
      expect(await store().getCompleted('scope', KEY)).toBeNull();

      await store().complete('scope', KEY, { ok: true });
      expect(await store().getCompleted('scope', KEY)).toEqual({ ok: true });
    });

    it('release frees an acquired key for retry', async () => {
      await store().acquire('scope', KEY);
      await store().release('scope', KEY);
      expect(await store().acquire('scope', KEY)).toBe('acquired');
    });
  });

  describe('PostgresProcessedWebhookStore', () => {
    it('dedupes by event id', async () => {
      const store = new PostgresProcessedWebhookStore(pool);
      expect(await store.wasProcessed('evt_1')).toBe(false);
      await store.markProcessed('evt_1');
      expect(await store.wasProcessed('evt_1')).toBe(true);
      await store.markProcessed('evt_1'); // idempotent
    });
  });

  describe('PostgresSettledPaymentQuery', () => {
    it('reports settlement from the intents snapshot', async () => {
      const query = new PostgresSettledPaymentQuery(pool);
      const intent = succeededIntent();
      expect(await query.isSettled(intent.intentId)).toBe(false);

      await new PostgresPaymentIntentRepository(pool).save(intent);

      expect(await query.isSettled(intent.intentId)).toBe(true);
    });
  });

  describe('wired: InitiatePaymentUseCase against Postgres', () => {
    it('persists snapshot, journal, and idempotency record; replays on retry', async () => {
      const useCase = new InitiatePaymentUseCase({
        idempotency: new PostgresIdempotencyStore(pool),
        intents: new PostgresPaymentIntentRepository(pool),
        ledger: new LedgerAppender(new PostgresLedgerRepository(pool)),
        unitOfWork: new UnitOfWork(pool),
      });

      const command = {
        amountMinor: 25_000,
        currency: 'NGN',
        method: 'card',
        idempotencyKey: 'wired-charge-000001',
      };
      const first = await useCase.execute(command);
      expect(first.ok).toBe(true);
      if (!first.ok) return;

      // All three writes landed.
      const { rows: intents } = await pool.query(
        'SELECT intent_id FROM payment_intents WHERE intent_id = $1',
        [first.value.intentId],
      );
      expect(intents).toHaveLength(1);
      const { rows: entries } = await pool.query(
        'SELECT event_type FROM ledger_entries WHERE aggregate_id = $1',
        [first.value.intentId],
      );
      expect(
        entries.map((r) => (r as { event_type: string }).event_type),
      ).toEqual(['PaymentInitiated']);

      // Replay: same key, no duplicate execution.
      const second = await useCase.execute(command);
      expect(second).toEqual(first);
      const { rows: counts } = await pool.query<{ n: number }>(
        'SELECT count(*)::int AS n FROM ledger_entries',
      );
      expect(counts[0].n).toBe(1);
    });
  });
});
