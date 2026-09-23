import { IllegalEscrowStateTransitionError } from './errors';

/**
 * The escrow lifecycle, modeled as an explicit finite state machine.
 *
 *   PENDING ──hold()──▶ HELD ──release/refund to full consumption──▶ RELEASED | REFUNDED
 *     │                  │
 *     │                  └─dispute()─▶ DISPUTED ──resolve()─▶ HELD
 *     ├──cancel()─▶ CANCELLED
 *     └──expire()─▶ EXPIRED
 *
 * Semantics:
 *  - PENDING: the escrow is registered against a payment intent, but the
 *    charge has not yet settled at the provider. No money movement of any
 *    kind is possible here — only confirmation (hold), cancellation, or
 *    expiry.
 *  - HELD: settlement is webhook-confirmed; the provider's own subaccount/
 *    split primitive is custodying the funds. Releases and refunds are
 *    possible, in ANY partial combination, as long as the aggregate
 *    consumption invariant holds (released + refunded ≤ held).
 *  - RELEASED / REFUNDED: terminal. Reached automatically when releases +
 *    refunds consume the full held amount; the state records which action
 *    closed the hold (a hold closed by a final refund is REFUNDED even if
 *    earlier partial releases occurred — the state is about how the hold
 *    ENDED, see Escrow.release/refund).
 *  - DISPUTED: a freeze. No releases or refunds while disputed; resolution
 *    returns the escrow to HELD and movement resumes. (Deliberately simple:
 *    disputes never jump straight to REFUNDED — refunding a disputed hold is
 *    a resolve() followed by a refund(), so each step is journaled.)
 *  - CANCELLED: terminal; only reachable from PENDING (an unsettled charge
 *    has no funds to return — the payment context handles the void).
 *  - EXPIRED: terminal; only reachable from PENDING. A time-bound hold whose
 *    underlying charge never settled before the booking window lapsed (e.g.
 *    a marketplace payout window closed without seller confirmation).
 *    Distinct from CANCELLED because the cause is a clock, not a manual
 *    decision — the audit trail must show which.
 */
export const ESCROW_STATES = [
  'PENDING',
  'HELD',
  'RELEASED',
  'REFUNDED',
  'DISPUTED',
  'CANCELLED',
  'EXPIRED',
] as const;

export type EscrowState = (typeof ESCROW_STATES)[number];

/**
 * The legal-transition table — the single source of truth for what comes
 * next. RELEASED and REFUNDED appear in HELD's list for the exclusive use of
 * the release()/refund() internals (they assert the transition only after
 * proving full consumption); there is no public operation that sets either
 * state directly. That keeps "close the hold" an earned state, not a
 * settable flag.
 */
const LEGAL_TRANSITIONS: Readonly<Record<EscrowState, readonly EscrowState[]>> =
  {
    PENDING: ['HELD', 'CANCELLED', 'EXPIRED'],
    HELD: ['DISPUTED', 'RELEASED', 'REFUNDED'],
    RELEASED: [],
    REFUNDED: [],
    DISPUTED: ['HELD'],
    CANCELLED: [],
    EXPIRED: [],
  };

export function isTerminalEscrowState(state: EscrowState): boolean {
  return (
    state === 'RELEASED' ||
    state === 'REFUNDED' ||
    state === 'CANCELLED' ||
    state === 'EXPIRED'
  );
}

/**
 * Guards every state mutation. Throws {@link IllegalEscrowStateTransitionError}
 * for anything not in {@link LEGAL_TRANSITIONS}, including all transitions
 * out of terminal states.
 */
export function assertLegalEscrowTransition(
  from: EscrowState,
  to: EscrowState,
): void {
  if (!LEGAL_TRANSITIONS[from].includes(to)) {
    throw new IllegalEscrowStateTransitionError(from, to);
  }
}
