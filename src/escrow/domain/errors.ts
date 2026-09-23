import { DomainError } from '../../shared/kernel/domain-error';

/**
 * Base class for every error thrown by the Escrow bounded context.
 * See {@link PaymentDomainError} for the rationale behind a per-context
 * error base class.
 */
export abstract class EscrowDomainError extends DomainError {}

/**
 * Thrown when an escrow operation would violate the state machine — e.g.
 * releasing from DISPUTED, or mutating an escrow that already reached a
 * terminal state. Illegal transitions throw; they never silently no-op,
 * because a silently ignored release is money that didn't move when someone
 * expected it to.
 */
export class IllegalEscrowStateTransitionError extends EscrowDomainError {
  readonly code = 'ILLEGAL_ESCROW_STATE_TRANSITION';

  constructor(
    readonly from: string,
    readonly to: string,
  ) {
    super(`Illegal escrow state transition: ${from} → ${to}`);
  }
}

/**
 * Thrown when an escrow operation is structurally invalid regardless of
 * state: zero or negative amounts, exceeding the remaining held amount,
 * missing provider references, and similar. Distinct from state errors so
 * callers can tell "wrong request" apart from "wrong moment".
 */
export class InvalidEscrowOperationError extends EscrowDomainError {
  readonly code = 'INVALID_ESCROW_OPERATION';

  constructor(reason: string) {
    super(`Invalid escrow operation: ${reason}`);
  }
}
