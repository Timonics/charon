/**
 * Read-only cross-context query: has this payment intent settled?
 *
 * The Escrow context needs to know a payment is SUCCEEDED before placing a
 * hold, but it must NOT import the Payments context's repositories or types
 * — that would weld the contexts together. This port is the seam:
 * infrastructure answers it from the payments projection/ledger, and the
 * escrow use case depends only on this interface.
 *
 * Deliberately read-only and boolean. If Escrow ever needs richer payment
 * facts, resist extending this — model a new query instead, or reconsider
 * the context boundary.
 */
export interface SettledPaymentQuery {
  isSettled(paymentIntentId: string): Promise<boolean>;
}
