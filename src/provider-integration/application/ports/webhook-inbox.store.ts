import type { NormalizedPaymentEvent } from '../../domain/normalized-payment-event';
import type { TransactionCapable } from '../../../shared/infrastructure/transaction-capable';

/**
 * Append-only store for verified provider webhooks.
 *
 * Why this exists
 * ---------------
 * The `webhook_inbox` table is the repair source when the ledger
 * raises a `SequenceGapError` — i.e. when a `next_sequence` insert
 * fails because a row arrived before its predecessor was journaled
 * (a real possibility when a provider redelivers an event hours or
 * days after a network partition). The migration comment on the
 * initial schema is the source of truth:
 *
 *   "webhook_inbox preserves every verified event verbatim. It is
 *    the repair source when a SequenceGapError fires: rebuild the
 *    ledger from here rather than asking providers to redeliver."
 *
 * Without a writer for this table, the repair path is unreachable:
 * the table exists in the schema, but no code in the application
 * ever writes to it. The audit, the migration comment, and the
 * operational runbook all promise a capability that isn't there.
 * This port closes that gap.
 *
 * What this port is NOT
 * ---------------------
 * - NOT a dedup store. Dedup is `processed_webhooks`, written by
 *   `ProcessedWebhookStore.markProcessed` in the same unit of work.
 *   Both writes happen together so a SequenceGapError repair can
 *   join the two on `(provider, event_id)` and reconstruct intent.
 * - NOT a denormalized query surface. The inbox is keyed by
 *   `(provider, event_id)`. Read paths are out of scope for this PR
 *   — they belong to a future "SequenceGapError repair command".
 *
 * Contract for implementors
 * -------------------------
 * - `recordVerifiedWebhook` MUST be idempotent on `(provider, event_id)`.
 *   The unique index is the schema-level backstop; ON CONFLICT
 *   DO NOTHING is the right SQL pattern.
 * - `recordVerifiedWebhook` MUST accept the `SqlExecutor` via `with(tx)`
 *   so the caller can put the inbox write in the same transaction
 *   as the dedup mark. The `TransactionCapable` base enforces this
 *   signature shape across the codebase.
 * - The port never reads. Reads are by a separate query port (not
 *   built in this PR).
 */
export interface WebhookInboxStore extends TransactionCapable<WebhookInboxStore> {
  /**
   * Persist a verified webhook event for later reconstruction.
   *
   * The `receivedAt` field on the row is taken from the event's
   * `occurredAt` (the provider's timestamp), not from the wall clock
   * at processing time. This matters when replaying: the inbox
   * preserves the original occurrence time so a SequenceGapError
   * repair can re-stamp ledger entries with the same `occurredAt`
   * the original would have had.
   *
   * Idempotent: a redelivered event with the same `(provider,
   * event_id)` is a no-op. The caller does NOT need to check before
   * writing; the unique index handles it.
   *
   * **The inbox is system-wide, not tenant-scoped.** The
   * `tenant_id` is NOT a column on this table and is NOT a
   * parameter here, by design. The inbox is the repair source for
   * the entire ledger; a `SequenceGapError` fixer needs to read
   * events across all tenants, not just one. The tenant boundary
   * is preserved by the `(provider, provider_charge_ref)` → join
   * to `payment_intents` (or `escrows`) → `tenant_id` path during
   * repair. Adding `tenant_id` here would optimize the repair
   * query but break the cross-tenant reconstruction use case.
   */
  recordVerifiedWebhook(event: NormalizedPaymentEvent): Promise<void>;
}
