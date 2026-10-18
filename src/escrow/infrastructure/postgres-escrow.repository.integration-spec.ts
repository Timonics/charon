import { Money } from '../../shared/kernel/money';
import { rehydrateTenantId, type Principal } from '../../shared/kernel/tenant';
import { Escrow } from '../domain/escrow';
import { ConfirmEscrowHoldUseCase } from '../application/confirm-escrow-hold.use-case';
import { PlaceEscrowHoldUseCase } from '../application/place-escrow-hold.use-case';
import { ReleaseEscrowUseCase } from '../application/release-escrow.use-case';
import type { SettledPaymentQuery } from '../application/ports/settled-payment.query';
import { PostgresEscrowRepository } from './postgres-escrow.repository';
import { PostgresIdempotencyStore } from '../../payments/infrastructure/postgres-idempotency.store';
import { LedgerAppender } from '../../ledger/application/ledger-appender';
import { PostgresLedgerRepository } from '../../ledger/infrastructure/postgres-ledger.repository';
import { UnitOfWork } from '../../shared/infrastructure/unit-of-work';
import {
  applyMigrations,
  closeIntegrationPool,
  integrationPool,
  truncateAll,
} from '../../../test/integration-setup';

const INTENT_ID = '3fa85f64-5717-4562-b3fc-2c963f66afa6';

/** Test principal + tenant — exercises the principal threading. */
const TEST_TENANT = rehydrateTenantId('a1b2c3d4-1111-4222-8333-444444444444');
const TEST_PRINCIPAL: Principal = {
  kind: 'app',
  appId: 'app-uuid-test',
  tenantId: TEST_TENANT,
  scopes: ['escrows:write', 'escrows:release'],
  expiresAt: new Date('2030-01-01T00:00:00Z'),
};

function heldEscrow(): Escrow {
  const escrow = Escrow.create({
    tenantId: TEST_TENANT,
    paymentIntentId: INTENT_ID,
    heldAmount: Money.of(10_000, 'NGN'),
    provider: 'paystack',
  });
  escrow.hold('PSK-SUBACCT-INFRA-1');
  escrow.release(Money.of(7_000, 'NGN'), 'seller-9');
  return escrow;
}

describe('PostgresEscrowRepository (integration)', () => {
  const pool = integrationPool();
  const repo = () => new PostgresEscrowRepository(pool);

  beforeAll(() => applyMigrations());
  beforeEach(async () => truncateAll(pool));
  afterAll(async () => closeIntegrationPool());

  it('round-trips a snapshot including custody ref and movement totals', async () => {
    const escrow = heldEscrow();
    await repo().save(escrow);

    const byId = await repo().findById(escrow.escrowId);
    expect(byId?.currentState).toBe('HELD');
    expect(byId?.custodyReference).toBe('PSK-SUBACCT-INFRA-1');
    expect(byId?.releasedToDate.amount).toBe(7_000);
    expect(byId?.availableAmount.amount).toBe(3_000);

    const byIntent = await repo().findByPaymentIntentId(INTENT_ID);
    expect(byIntent?.escrowId).toBe(escrow.escrowId);

    expect(
      await repo().findById('00000000-0000-0000-0000-000000000000'),
    ).toBeNull();
  });

  describe('wired: full escrow lifecycle against Postgres', () => {
    it('place → confirm → release, with the ledger as the journal', async () => {
      const settled: SettledPaymentQuery = {
        isSettled: () => Promise.resolve(true),
      };
      const appender = new LedgerAppender(new PostgresLedgerRepository(pool));
      const unitOfWork = new UnitOfWork(pool);
      const place = new PlaceEscrowHoldUseCase({
        principal: TEST_PRINCIPAL,
        idempotency: new PostgresIdempotencyStore(pool),
        escrows: repo(),
        ledger: appender,
        settledPayments: settled,
        unitOfWork,
      });
      const confirm = new ConfirmEscrowHoldUseCase({
        escrows: repo(),
        ledger: appender,
        unitOfWork,
      });
      const release = new ReleaseEscrowUseCase({
        idempotency: new PostgresIdempotencyStore(pool),
        escrows: repo(),
        ledger: appender,
        unitOfWork,
      });

      const placed = await place.execute({
        paymentIntentId: INTENT_ID,
        amountMinor: 12_000,
        currency: 'NGN',
        provider: 'paystack',
        idempotencyKey: 'wired-escrow-0001',
      });
      expect(placed.ok).toBe(true);
      if (!placed.ok) return;
      const { escrowId } = placed.value;

      const confirmed = await confirm.execute({
        paymentIntentId: INTENT_ID,
        providerCustodyRef: 'PSK-SUBACCT-WIRED',
      });
      expect(confirmed).toEqual({
        ok: true,
        value: { outcome: 'HELD', escrowId },
      });

      const released = await release.execute({
        escrowId,
        amountMinor: 12_000,
        currency: 'NGN',
        idempotencyKey: 'wired-release-0001',
      });
      expect(released.ok).toBe(true);
      if (!released.ok) return;
      expect(released.value.state).toBe('RELEASED');

      // Snapshot state and journal history agree.
      const escrow = await repo().findById(escrowId);
      expect(escrow?.currentState).toBe('RELEASED');

      const { rows } = await pool.query<{
        event_type: string;
        sequence: number;
      }>(
        'SELECT event_type, sequence FROM ledger_entries WHERE aggregate_id = $1 ORDER BY sequence',
        [escrowId],
      );
      expect(rows.map((r) => r.event_type)).toEqual([
        'EscrowInitiated',
        'EscrowHeld',
        'EscrowReleased',
      ]);
      // bigint arrives as string from node-postgres; assert numeric order.
      expect(rows.map((r) => Number(r.sequence))).toEqual([1, 2, 3]);
    });
  });
});
