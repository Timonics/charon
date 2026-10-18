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
import { PostgresWebhookInboxStore } from '../../provider-integration/infrastructure/postgres-webhook-inbox.store';
import { PostgresSettledPaymentQuery } from './postgres-settled-payment.query';
import { NormalizedPaymentEvent } from '../../provider-integration/domain/normalized-payment-event';
import type {
  PaymentGatewayPort,
  InitializeChargeInput,
  InitializedCharge,
} from '../../provider-integration/application/ports/payment-gateway.port';
import { ok, type Result } from '../../shared/kernel/result';
import { ProviderName } from '../../shared/kernel/provider-name';
import { DomainError } from '../../shared/kernel/domain-error';
import { rehydrateTenantId, type Principal } from '../../shared/kernel/tenant';
import {
  applyMigrations,
  closeIntegrationPool,
  integrationPool,
  truncateAll,
} from '../../../test/integration-setup';

/**
 * Noop gateway for the wired use-case spec. The spec does not
 * care about the provider round-trip — that's the gateway
 * adapter's own spec's job — only that the intent ends up in
 * PROCESSING with a `chargeReference` set.
 */
class FakeGatewayAdapter implements PaymentGatewayPort {
  readonly provider: ProviderName = 'paystack';
  async initializeCharge(
    input: InitializeChargeInput,
  ): Promise<Result<InitializedCharge, DomainError>> {
    await Promise.resolve();
    return ok({
      providerReference: input.reference,
      checkoutUrl: 'https://checkout.test/integration',
      raw: { testEcho: true },
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

const KEY = 'infra-test-key-0001' as IdempotencyKey;

/** Test tenant + principal — exercises the principal threading. */
const TEST_TENANT = rehydrateTenantId('a1b2c3d4-1111-4222-8333-444444444444');
const TEST_PRINCIPAL: Principal = {
  kind: 'app',
  appId: 'app-uuid-test',
  tenantId: TEST_TENANT,
  scopes: ['payments:write', 'escrows:write'],
  expiresAt: new Date('2030-01-01T00:00:00Z'),
};

function succeededIntent() {
  const intent = PaymentIntent.create({
    tenantId: TEST_TENANT,
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

    it('upserts on repeated saves (with a reload between them)', async () => {
      const intent = succeededIntent();
      await repo().save(intent);
      // Re-read the aggregate. After the first save, the row's version
      // is 1; the in-memory aggregate still has version=0 from creation.
      // Reloading refreshes the version so the second save's
      // compare-and-swap can match. This is the production pattern:
      // every use case loads → mutates → saves, never save-twice-without-
      // re-read. (Save twice without reload would correctly throw
      // OptimisticLockError — that's the point of the version column.)
      const reloaded = await repo().findById(intent.intentId);
      expect(reloaded).not.toBeNull();
      // Re-saving the reloaded snapshot is idempotent and must not duplicate.
      await repo().save(reloaded!);
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

  describe('PostgresWebhookInboxStore', () => {
    // The inbox is the "repair source" the migration comment on the
    // initial schema promises — the table SequenceGapError fixes
    // read back from. This spec proves a real round-trip into
    // Postgres, not just the in-memory fake.
    it('persists a verified event with the payload + signature flag', async () => {
      const inbox = new PostgresWebhookInboxStore(pool);
      const event = new NormalizedPaymentEvent({
        eventId: 'evt_inbox_1',
        provider: 'paystack',
        type: 'CHARGE_SUCCEEDED',
        providerRef: 'PSK-REF-1',
        occurredAt: new Date('2026-10-17T12:00:00Z'),
        amountMinor: 25_000,
        currency: 'NGN',
        raw: { original: 'payload', from: 'paystack' },
      });
      await inbox.recordVerifiedWebhook(event);

      // Read back via raw query — the port is write-only by
      // design (a read port lands with the repair command, not
      // this PR), so we exercise the schema directly.
      const { rows } = await pool.query<{
        provider: string;
        event_id: string;
        event_type: string;
        payload: Record<string, unknown>;
        signature_valid: boolean;
        received_at: Date;
        processed_at: Date | null;
      }>(
        `SELECT provider, event_id, event_type, payload,
                signature_valid, received_at, processed_at
         FROM webhook_inbox
         WHERE provider = $1 AND event_id = $2`,
        [event.provider, event.eventId],
      );
      expect(rows).toHaveLength(1);
      const row = rows[0];
      expect(row.provider).toBe('paystack');
      expect(row.event_id).toBe('evt_inbox_1');
      expect(row.event_type).toBe('CHARGE_SUCCEEDED');
      expect(row.signature_valid).toBe(true);
      expect(row.processed_at).toBeNull();
      expect(row.payload).toMatchObject({
        eventId: 'evt_inbox_1',
        provider: 'paystack',
        type: 'CHARGE_SUCCEEDED',
        providerRef: 'PSK-REF-1',
        amountMinor: 25_000,
        currency: 'NGN',
        raw: { original: 'payload', from: 'paystack' },
      });
    });

    it('is idempotent on (provider, event_id) — redelivery is a no-op', async () => {
      const inbox = new PostgresWebhookInboxStore(pool);
      const event = new NormalizedPaymentEvent({
        eventId: 'evt_inbox_idem',
        provider: 'stripe',
        type: 'CHARGE_SUCCEEDED',
        providerRef: 'STR-REF-1',
        occurredAt: new Date('2026-10-17T13:00:00Z'),
      });
      await inbox.recordVerifiedWebhook(event);
      await inbox.recordVerifiedWebhook(event); // redelivery

      const { rows } = await pool.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM webhook_inbox
         WHERE provider = $1 AND event_id = $2`,
        [event.provider, event.eventId],
      );
      expect(rows[0].count).toBe('1');
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
      // The integration spec exercises the full persistence
      // path against real Postgres. The gateway is faked because
      // (a) the spec does not depend on Paystack's response
      // shape, and (b) hitting api.paystack.co in CI is forbidden
      // by non-negotiable #11. The fake echoes the input
      // reference; the assertions downstream care only that
      // `chargeReference` is set.
      const gateway: PaymentGatewayPort = new FakeGatewayAdapter();
      const useCase = new InitiatePaymentUseCase({
        principal: TEST_PRINCIPAL,
        idempotency: new PostgresIdempotencyStore(pool),
        intents: new PostgresPaymentIntentRepository(pool),
        ledger: new LedgerAppender(new PostgresLedgerRepository(pool)),
        gateways: new Map<ProviderName, PaymentGatewayPort>([
          [gateway.provider, gateway],
        ]),
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
