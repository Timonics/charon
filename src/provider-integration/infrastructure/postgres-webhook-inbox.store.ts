import type { SqlExecutor } from '../../shared/infrastructure/db';
import type { NormalizedPaymentEvent } from '../domain/normalized-payment-event';
import type { WebhookInboxStore } from '../application/ports/webhook-inbox.store';

/**
 * Postgres implementation of {@link WebhookInboxStore}.
 *
 * Schema: the `webhook_inbox` table is defined in
 * `migrations/1720000000000_initial-schema.js` with columns:
 *
 *   inbox_id        uuid          pk
 *   provider        text          not null
 *   event_id        text          not null
 *   event_type      text          nullable
 *   payload         jsonb         not null
 *   signature_valid boolean       not null
 *   received_at     timestamptz   not null
 *   processed_at    timestamptz   nullable
 *
 * The inbox is intentionally **not** tenant-scoped: it's a
 * system-wide repair source for the entire ledger. A future
 * `SequenceGapError` repair command needs to read events across
 * all tenants; the tenant boundary is reconstructed by joining
 * to `payment_intents` / `escrows` on `(provider, charge_ref)`.
 *
 * Plus a unique index on (provider, event_id) — the schema-level
 * backstop that makes a redelivered event a no-op without any
 * application-level "check then write" race.
 *
 * Why this lives in infrastructure/, not application/
 * -------------------------------------------------
 * The SQL is the only thing this adapter knows. Domain code asks
 * for `recordVerifiedWebhook(event)` and gets a `Promise<void>`.
 * The SQL is the entire point of an adapter — the only piece of
 * Postgres-specific knowledge in the codebase.
 *
 * The `payload` is a JSONB column holding the original provider
 * payload (the `raw` field on the NormalizedPaymentEvent, when
 * present). This is what the migration comment calls the
 * "repair source": a SequenceGapError fixer can reconstruct the
 * original event verbatim from this column.
 *
 * `received_at` is taken from the event's `occurredAt` (the
 * provider's timestamp), not from `now()`. This matters for
 * replay: when the gap is repaired, the journaled events get
 * the same `occurredAt` the original would have had, keeping
 * the ledger's notion of time faithful to the provider's.
 */
export class PostgresWebhookInboxStore implements WebhookInboxStore {
  constructor(private readonly db: SqlExecutor) {}

  async recordVerifiedWebhook(event: NormalizedPaymentEvent): Promise<void> {
    // The event type is stored as the NORMALIZED enum value
    // ('CHARGE_SUCCEEDED', 'TRANSFER_COMPLETED', ...), not the
    // provider's native event name. The provider's native name
    // is preserved inside the `payload` jsonb if it was captured
    // there, but the inbox column is the internal taxonomy.
    //
    // The payload column holds `event.raw` when present, falling
    // back to a minimal object containing the normalized fields
    // themselves — this gives a SequenceGapError fixer enough
    // to replay the event without needing the original raw
    // bytes (which we no longer hold by this point in the
    // pipeline).
    const payload = this.serializePayload(event);

    await this.db.query(
      `INSERT INTO webhook_inbox
         (inbox_id, provider, event_id, event_type, payload,
          signature_valid, received_at, processed_at)
       VALUES
         (gen_random_uuid(), $1, $2, $3, $4::jsonb, $5, $6, NULL)
       ON CONFLICT (provider, event_id) DO NOTHING`,
      [
        event.provider,
        event.eventId,
        event.type,
        JSON.stringify(payload),
        true, // signature_valid: we only write verified events
        event.occurredAt,
      ],
    );
  }

  /**
   * Returns a new store instance bound to the given SQL executor.
   * See {@link TransactionCapable.with} for the shared contract
   * — every repository in the codebase implements this so the
   * same SQL runs inside or outside a transaction.
   */
  with(tx: SqlExecutor): PostgresWebhookInboxStore {
    return new PostgresWebhookInboxStore(tx);
  }

  /**
   * Serialize the event for the JSONB column. We always include
   * the normalized fields so a SequenceGapError fixer can
   * reconstruct intent from the inbox row alone, even when the
   * provider's raw payload was stripped (e.g. signed headers
   * only, no body captured at the adapter boundary).
   */
  private serializePayload(
    event: NormalizedPaymentEvent,
  ): Record<string, unknown> {
    const base: Record<string, unknown> = {
      eventId: event.eventId,
      provider: event.provider,
      type: event.type,
      providerRef: event.providerRef,
      occurredAt: event.occurredAt.toISOString(),
    };
    if (event.amountMinor !== undefined) base.amountMinor = event.amountMinor;
    if (event.currency !== undefined) base.currency = event.currency;
    if (event.failureReason !== undefined)
      base.failureReason = event.failureReason;
    // `raw` is whatever the adapter passed through. Some
    // adapters forward the full provider payload here; others
    // pass `undefined`. The inbox tolerates both.
    if (event.raw !== undefined) base.raw = event.raw;
    return base;
  }
}
