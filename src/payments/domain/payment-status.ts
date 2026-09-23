import { IllegalPaymentStatusTransitionError } from './errors';

/**
 * The payment-intent lifecycle, modeled as an explicit finite state machine.
 *
 * Why a state machine and not a boolean/`string` flag: payment state is the
 * single most audit-sensitive property of this service. Illegal transitions
 * (e.g. marking a FAILED charge as SUCCEEDED because a webhook arrived late
 * and out of order) must be *impossible by construction*, not guarded by
 * convention. Every mutation on {@link PaymentIntent} routes through
 * {@link assertLegalTransition}, so the set of reachable states is exactly
 * the set drawn here.
 *
 * Lifecycle:
 *
 *   INITIATED ──▶ PROCESSING ──▶ SUCCEEDED
 *      │              │
 *      │              ├──▶ FAILED
 *      │              └──▶ EXPIRED
 *      ├──▶ FAILED
 *      └──▶ EXPIRED
 *
 * Design notes:
 *  - `INITIATED` means the intent has been recorded locally and handed to a
 *    provider. We deliberately allow FAILED/EXPIRED directly from INITIATED
 *    because a provider call can fail before the charge ever starts, and
 *    authorizations can simply never be attempted.
 *  - There is intentionally NO direct INITIATED → SUCCEEDED edge. Settlement
 *    truth comes from verified webhooks, and every provider flow we use goes
 *    through an explicit in-flight state first. If a real flow turns out to
 *    confirm synchronously, that is a routing decision to revisit, not an
 *    edge to add silently.
 */
export const PAYMENT_STATUSES = [
  'INITIATED',
  'PROCESSING',
  'SUCCEEDED',
  'FAILED',
  'EXPIRED',
] as const;

export type PaymentStatus = (typeof PAYMENT_STATUSES)[number];

/**
 * The legal-transition table. The ONLY source of truth for what comes next;
 * {@link assertLegalTransition} reads nothing else.
 */
const LEGAL_TRANSITIONS: Readonly<
  Record<PaymentStatus, readonly PaymentStatus[]>
> = {
  INITIATED: ['PROCESSING', 'FAILED', 'EXPIRED'],
  PROCESSING: ['SUCCEEDED', 'FAILED', 'EXPIRED'],
  SUCCEEDED: [],
  FAILED: [],
  EXPIRED: [],
};

/**
 * Terminal states are immutable. Once money has definitively moved (or
 * definitively not moved), the intent is a historical fact; corrections
 * happen through new intents and refunds, never by rewriting history.
 */
export function isTerminalStatus(status: PaymentStatus): boolean {
  return status === 'SUCCEEDED' || status === 'FAILED' || status === 'EXPIRED';
}

/**
 * Guards every status mutation. Throws {@link IllegalPaymentStatusTransitionError}
 * for anything not present in {@link LEGAL_TRANSITIONS} — including all
 * transitions out of terminal states.
 */
export function assertLegalTransition(
  from: PaymentStatus,
  to: PaymentStatus,
): void {
  if (!LEGAL_TRANSITIONS[from].includes(to)) {
    throw new IllegalPaymentStatusTransitionError(from, to);
  }
}
