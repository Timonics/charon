import type { SettledPaymentQuery } from '../../escrow/application/ports/settled-payment.query';
import type { SqlExecutor } from '../../shared/infrastructure/db';

/**
 * Read-side implementation of the Escrow context's settled-payment seam.
 * Answers from the payment_intents snapshot — one indexed point lookup.
 *
 * Settled means status = 'SUCCEEDED': webhook-confirmed settlement, the
 * only state in which the Escrow domain permits a hold. When the Payments
 * context's snapshot and the ledger could disagree, the ledger is the
 * authority — but for this gate the snapshot is the operational read model
 * and is kept consistent by the same transactions that journal events.
 */
export class PostgresSettledPaymentQuery implements SettledPaymentQuery {
  constructor(private readonly db: SqlExecutor) {}

  async isSettled(paymentIntentId: string): Promise<boolean> {
    const result = await this.db.query<{ status: string }>(
      'SELECT status FROM payment_intents WHERE intent_id = $1',
      [paymentIntentId],
    );
    return result.rows[0]?.status === 'SUCCEEDED';
  }
}
