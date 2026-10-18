import { Escrow } from '../domain/escrow';
import type { EscrowSnapshot } from '../domain/escrow';
import type { EscrowState } from '../domain/escrow-state';
import type { EscrowRepository } from '../application/ports/escrow.repository';
import type { ProviderName } from '../../shared/kernel/provider-name';
import { OptimisticLockError } from '../../shared/kernel/optimistic-lock.error';
import { rehydrateTenantId } from '../../shared/kernel/tenant';
import type { SqlExecutor } from '../../shared/infrastructure/db';
import { toSafeInteger, trimChar } from '../../shared/infrastructure/pg-types';

/** Row shape of the escrows table as returned by node-postgres. */
interface EscrowRow {
  escrow_id: string;
  payment_intent_id: string;
  held_amount_minor: string;
  currency: string;
  provider: string;
  state: string;
  provider_custody_ref: string | null;
  released_amount_minor: string;
  refunded_amount_minor: string;
  external_ref: string | null;
  created_at: Date;
  version: string;
  tenant_id: string;
}

/**
 * Postgres implementation of the Escrow snapshot port. Same semantics as
 * the PaymentIntent repository: whole-aggregate upsert, history untouched,
 * row mapping with validated BIGINT parsing at the boundary.
 *
 * Concurrency: save() is a compare-and-swap on the `version` column.
 * The aggregate carries the version it loaded at read time (via
 * toSnapshot()), and the UPDATE only succeeds if the row's version
 * still matches. A concurrent writer that loaded the same version and
 * saved first will have bumped the version, so this UPDATE matches
 * zero rows and we throw OptimisticLockError. The use case's
 * UnitOfWork rolls back; the application layer decides whether to
 * retry (idempotent commands) or surface a conflict.
 */
export class PostgresEscrowRepository implements EscrowRepository {
  constructor(private readonly db: SqlExecutor) {}

  async save(escrow: Escrow): Promise<void> {
    const s = escrow.toSnapshot();
    // The aggregate's `version` is the PRE-state version — the version
    // the row currently holds (or 0 for a brand-new aggregate whose
    // row doesn't exist yet). The save() compare-and-swap writes
    // `version = s.version + 1` (the post-state version), and the
    // WHERE clause checks `version = s.version` to detect a concurrent
    // writer that bumped the version between the aggregate's read
    // and save().
    const preStateVersion = s.version;
    const result = await this.db.query(
      `INSERT INTO escrows (
         escrow_id, payment_intent_id, held_amount_minor, currency, provider,
         state, provider_custody_ref, released_amount_minor,
         refunded_amount_minor, external_ref, created_at, updated_at, version,
         tenant_id
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
       ON CONFLICT (escrow_id) DO UPDATE SET
         state = EXCLUDED.state,
         provider_custody_ref = EXCLUDED.provider_custody_ref,
         released_amount_minor = EXCLUDED.released_amount_minor,
         refunded_amount_minor = EXCLUDED.refunded_amount_minor,
         updated_at = EXCLUDED.updated_at,
         version = escrows.version + 1
       WHERE escrows.escrow_id = EXCLUDED.escrow_id
         AND escrows.version = $15`,
      [
        s.escrowId,
        s.paymentIntentId,
        s.heldAmount.amount,
        s.heldAmount.currency,
        s.provider,
        s.state,
        s.providerCustodyRef ?? null,
        s.releasedAmount.amount,
        s.refundedAmount.amount,
        s.externalRef ?? null,
        s.createdAt,
        new Date(),
        // New rows: write the post-state version (pre + 1). 0 + 1 = 1.
        preStateVersion + 1,
        s.tenantId,
        // For an existing row: the version the aggregate loaded (pre-state).
        // For a new row: not read by the INSERT path, but pass the same
        // value for safety.
        preStateVersion,
      ],
    );
    // rowCount === 1 means either INSERT or UPDATE succeeded.
    // rowCount === 0 means ON CONFLICT's WHERE filtered out the UPDATE
    // (the row's version no longer matches the pre-state version we
    // expected, because a concurrent writer bumped it).
    if (result.rowCount === 0) {
      throw new OptimisticLockError('Escrow', s.escrowId, preStateVersion);
    }
  }

  async findById(escrowId: string): Promise<Escrow | null> {
    const result = await this.db.query<EscrowRow>(
      'SELECT * FROM escrows WHERE escrow_id = $1',
      [escrowId],
    );
    return result.rows[0] ? rowToAggregate(result.rows[0]) : null;
  }

  async findByPaymentIntentId(paymentIntentId: string): Promise<Escrow | null> {
    const result = await this.db.query<EscrowRow>(
      'SELECT * FROM escrows WHERE payment_intent_id = $1',
      [paymentIntentId],
    );
    return result.rows[0] ? rowToAggregate(result.rows[0]) : null;
  }

  /**
   * Returns a new repository instance bound to the given SQL executor.
   * Same-instance calls share no state — each `with()` call returns a
   * fresh object, so concurrent transactions on the same originating
   * repository cannot interfere.
   */
  with(tx: SqlExecutor): PostgresEscrowRepository {
    return new PostgresEscrowRepository(tx);
  }
}

function rowToAggregate(row: EscrowRow): Escrow {
  const currency = trimChar(row.currency);
  const snapshot: EscrowSnapshot = {
    escrowId: row.escrow_id,
    tenantId: rehydrateTenantId(row.tenant_id),
    paymentIntentId: row.payment_intent_id,
    heldAmount: {
      amount: toSafeInteger(row.held_amount_minor, 'held_amount_minor'),
      currency,
    },
    provider: row.provider as ProviderName,
    externalRef: row.external_ref ?? undefined,
    createdAt: row.created_at,
    state: row.state as EscrowState,
    providerCustodyRef: row.provider_custody_ref ?? undefined,
    releasedAmount: {
      amount: toSafeInteger(row.released_amount_minor, 'released_amount_minor'),
      currency,
    },
    refundedAmount: {
      amount: toSafeInteger(row.refunded_amount_minor, 'refunded_amount_minor'),
      currency,
    },
    version: toSafeInteger(row.version, 'version'),
  };
  return Escrow.fromSnapshot(snapshot);
}
