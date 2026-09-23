import type { ProviderName } from '../../../shared/kernel/provider-name';
import type { PaymentIntent } from '../../domain/payment-intent';
import type { SqlExecutor } from '../../../shared/infrastructure/db';
import type { TransactionCapable } from '../../../shared/infrastructure/transaction-capable';

/**
 * Persistence port for the PaymentIntent aggregate. Implemented in
 * infrastructure (Postgres); fakes live in test code.
 *
 * Important: the repository persists the aggregate's *current state* (a
 * snapshot that lets us reload and continue the intent). It is NOT the
 * historical record — history lives exclusively in the append-only ledger.
 * If the two ever disagree, the ledger wins and the snapshot may be
 * rebuilt by replay.
 *
 * Contract for implementors: `save` MUST be an upsert keyed on intentId,
 * and it MUST be callable inside the same transaction as ledger appends
 * and idempotency completion for a command (the infrastructure unit of
 * work coordinates this).
 */
export interface PaymentIntentRepository extends TransactionCapable<PaymentIntentRepository> {
  /** Inserts or updates the aggregate's current state. */
  save(intent: PaymentIntent): Promise<void>;

  /** Reloads an aggregate by id, or null when unknown. */
  findById(intentId: string): Promise<PaymentIntent | null>;

  /**
   * Locates an aggregate by its provider charge reference — the
   * reconciliation key that links provider webhooks to internal intents.
   * Returns null when no intent carries this (provider, ref) pair, which the
   * webhook handler treats as "event for a charge we don't know": rejected,
   * never guessed at.
   *
   * Contract for implementors: needs a unique index on
   * (provider, provider_charge_ref) so lookups are exact and fast.
   */
  findByProviderChargeRef(
    provider: ProviderName,
    providerRef: string,
  ): Promise<PaymentIntent | null>;
}

/**
 * Convenience export so callers don't have to know the path of
 * `SqlExecutor`. The unit-of-work `tx` argument satisfies this type because
 * PoolClient.query has the same shape as Pool.query.
 */
export type { SqlExecutor };
