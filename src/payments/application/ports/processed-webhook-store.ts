/**
 * Dedup store for provider webhooks, keyed by the provider's event/delivery
 * id (see NormalizedPaymentEvent.eventId).
 *
 * Providers deliver events at-least-once: retries after timeouts and
 * redeliveries across days are normal, not exceptional. Without this store
 * every retry would re-run the domain transition — harmless only when the
 * state machine happens to reject it. We dedupe BEFORE acting so retries
 * are cheap no-ops and the ledger stays clean of duplicate entries.
 *
 * Contract for implementors: `wasProcessed` + `markProcessed` must behave
 * atomically in aggregate (unique key on eventId); the use case checks then
 * marks, and a crash in between must be safe to redeliver (the state
 * machine's already-in-target-state guard is the second line of defense —
 * see HandlePaymentWebhookUseCase).
 */
import type { SqlExecutor } from '../../../shared/infrastructure/db';
import type { TransactionCapable } from '../../../shared/infrastructure/transaction-capable';

export interface ProcessedWebhookStore extends TransactionCapable<ProcessedWebhookStore> {
  /** True when this event id has been fully applied before. */
  wasProcessed(eventId: string): Promise<boolean>;

  /** Records the event id as fully applied. Idempotent by nature of the key. */
  markProcessed(eventId: string): Promise<void>;
}

export type { SqlExecutor };
