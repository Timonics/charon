import { PaymentIntent } from '../domain/payment-intent';
import type { PaymentIntentRepository } from '../application/ports/payment-intent.repository';
import type { PaymentIntentSnapshot } from '../domain/payment-intent';
import type { PaymentMethod } from '../domain/payment-method';
import type { PaymentStatus } from '../domain/payment-status';
import type { ProviderName } from '../../shared/kernel/provider-name';
import { OptimisticLockError } from '../../shared/kernel/optimistic-lock.error';
import type { SqlExecutor } from '../../shared/infrastructure/db';
import { toSafeInteger, trimChar } from '../../shared/infrastructure/pg-types';

/** Row shape of the payment_intents table as returned by node-postgres. */
interface PaymentIntentRow {
  intent_id: string;
  idempotency_key: string;
  amount_minor: string;
  currency: string;
  method: string;
  provider: string;
  status: string;
  provider_charge_ref: string | null;
  refunded_amount_minor: string;
  customer_ref: string | null;
  description: string | null;
  created_at: Date;
  version: string;
}

/**
 * Postgres implementation of the PaymentIntent snapshot port.
 *
 * Snapshot semantics (see the domain's PaymentIntentSnapshot): only CURRENT
 * STATE is stored; history is never touched here. `save` is an upsert — the
 * aggregate is saved whole, never field-patched, so a save always reflects
 * one complete, consistent command outcome.
 *
 * Concurrency: save() is a compare-and-swap on the `version` column.
 * Without it, two concurrent refund-escrow or refund-payment calls can
 * both pass the in-memory cumulative-refund check and over-refund a
 * charged amount. The compare-and-swap makes the second writer fail
 * loudly with OptimisticLockError; the use case's UnitOfWork rolls
 * back, and the application layer surfaces the conflict.
 */
export class PostgresPaymentIntentRepository implements PaymentIntentRepository {
  constructor(private readonly db: SqlExecutor) {}

  async save(intent: PaymentIntent): Promise<void> {
    const s = intent.toSnapshot();
    // The aggregate's `version` is the PRE-state version — what the
    // row currently holds (or 0 for a brand-new intent). The compare-
    // and-swap writes `version = s.version + 1` (post-state) and the
    // WHERE clause checks `version = s.version`. A concurrent writer
    // that saved first will have bumped the version, so the WHERE
    // matches zero rows and we throw OptimisticLockError.
    const preStateVersion = s.version;
    const result = await this.db.query(
      `INSERT INTO payment_intents (
         intent_id, idempotency_key, amount_minor, currency, method, provider,
         status, provider_charge_ref, refunded_amount_minor, customer_ref,
         description, created_at, updated_at, version
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
       ON CONFLICT (intent_id) DO UPDATE SET
         idempotency_key = EXCLUDED.idempotency_key,
         amount_minor = EXCLUDED.amount_minor,
         currency = EXCLUDED.currency,
         method = EXCLUDED.method,
         provider = EXCLUDED.provider,
         status = EXCLUDED.status,
         provider_charge_ref = EXCLUDED.provider_charge_ref,
         refunded_amount_minor = EXCLUDED.refunded_amount_minor,
         customer_ref = EXCLUDED.customer_ref,
         description = EXCLUDED.description,
         updated_at = EXCLUDED.updated_at,
         version = payment_intents.version + 1
       WHERE payment_intents.intent_id = EXCLUDED.intent_id
         AND payment_intents.version = $15`,
      [
        s.intentId,
        s.idempotencyKey,
        s.amount.amount,
        s.amount.currency,
        s.method,
        s.provider,
        s.status,
        s.providerChargeRef ?? null,
        s.refundedAmount.amount,
        s.customerRef ?? null,
        s.description ?? null,
        s.createdAt,
        new Date(),
        preStateVersion + 1,
        preStateVersion,
      ],
    );
    if (result.rowCount === 0) {
      throw new OptimisticLockError(
        'PaymentIntent',
        s.intentId,
        preStateVersion,
      );
    }
  }

  async findById(intentId: string): Promise<PaymentIntent | null> {
    const result = await this.db.query<PaymentIntentRow>(
      'SELECT * FROM payment_intents WHERE intent_id = $1',
      [intentId],
    );
    return result.rows[0] ? rowToSnapshot(result.rows[0]) : null;
  }
  /** Reloads an aggregate by provider charge reference, or null. */
  async findByProviderChargeRef(
    provider: ProviderName,
    providerRef: string,
  ): Promise<PaymentIntent | null> {
    const result = await this.db.query<PaymentIntentRow>(
      'SELECT * FROM payment_intents WHERE provider = $1 AND provider_charge_ref = $2',
      [provider, providerRef],
    );
    return result.rows[0] ? rowToSnapshot(result.rows[0]) : null;
  }

  /**
   * Returns a new repository instance bound to the given SQL executor.
   * Same-instance calls share no state — each `with()` call returns a
   * fresh object, so concurrent transactions on the same originating
   * repository cannot interfere.
   */
  with(tx: SqlExecutor): PostgresPaymentIntentRepository {
    return new PostgresPaymentIntentRepository(tx);
  }
}

/**
 * Maps a row to a rehydrated aggregate. Parsing happens here, at the
 * persistence boundary — BIGINT strings become validated integers, char(3)
 * gets trimmed, and the domain receives only legal snapshot values.
 */
function rowToSnapshot(row: PaymentIntentRow): PaymentIntent {
  const snapshot: PaymentIntentSnapshot = {
    intentId: row.intent_id,
    amount: {
      amount: toSafeInteger(row.amount_minor, 'amount_minor'),
      currency: trimChar(row.currency),
    },
    method: row.method as PaymentMethod,
    provider: row.provider as ProviderName,
    idempotencyKey:
      row.idempotency_key as PaymentIntentSnapshot['idempotencyKey'],
    customerRef: row.customer_ref ?? undefined,
    description: row.description ?? undefined,
    createdAt: row.created_at,
    status: row.status as PaymentStatus,
    providerChargeRef: row.provider_charge_ref ?? undefined,
    refundedAmount: {
      amount: toSafeInteger(row.refunded_amount_minor, 'refunded_amount_minor'),
      currency: trimChar(row.currency),
    },
    version: toSafeInteger(row.version, 'version'),
  };
  return PaymentIntent.fromSnapshot(snapshot);
}
