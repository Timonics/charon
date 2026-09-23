import type { Escrow } from '../../domain/escrow';
import type { SqlExecutor } from '../../../shared/infrastructure/db';
import type { TransactionCapable } from '../../../shared/infrastructure/transaction-capable';

/**
 * Persistence port for the Escrow aggregate. Same contract shape and
 * philosophy as the PaymentIntent repository: this stores the aggregate's
 * CURRENT STATE snapshot; history lives in the append-only ledger and wins
 * on any disagreement. `save` must upsert and be transaction-capable.
 */
export interface EscrowRepository extends TransactionCapable<EscrowRepository> {
  /** Inserts or updates the aggregate's current state. */
  save(escrow: Escrow): Promise<void>;

  /** Reloads an aggregate by id, or null when unknown. */
  findById(escrowId: string): Promise<Escrow | null>;

  /**
   * Finds the escrow registered against a payment intent (one per intent —
   * see DuplicateEscrowForPaymentError), or null.
   */
  findByPaymentIntentId(paymentIntentId: string): Promise<Escrow | null>;
}

export type { SqlExecutor };
