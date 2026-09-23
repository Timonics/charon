import type { ProcessedWebhookStore } from '../application/ports/processed-webhook-store';
import type { SqlExecutor } from '../../shared/infrastructure/db';

/**
 * Postgres implementation of webhook delivery dedup. The primary key on
 * event_id makes `markProcessed` idempotent; a redelivered event that
 * slips past `wasProcessed` (crash window between apply and mark) simply
 * hits the domain's already-in-target-state guard, exactly as designed.
 */
export class PostgresProcessedWebhookStore implements ProcessedWebhookStore {
  constructor(private readonly db: SqlExecutor) {}

  async wasProcessed(eventId: string): Promise<boolean> {
    const result = await this.db.query(
      'SELECT 1 AS found FROM processed_webhooks WHERE event_id = $1',
      [eventId],
    );
    return result.rowCount === 1;
  }

  async markProcessed(eventId: string): Promise<void> {
    await this.db.query(
      `INSERT INTO processed_webhooks (event_id, processed_at)
       VALUES ($1, now())
       ON CONFLICT (event_id) DO NOTHING`,
      [eventId],
    );
  }

  /**
   * Returns a new store instance bound to the given SQL executor. See
   * {@link TransactionCapable.with} for the shared contract.
   */
  with(tx: SqlExecutor): PostgresProcessedWebhookStore {
    return new PostgresProcessedWebhookStore(tx);
  }
}
