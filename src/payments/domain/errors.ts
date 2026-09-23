import { DomainError } from '../../shared/kernel/domain-error';

/**
 * Base class for every error thrown by the Payments bounded context.
 *
 * Keeping a single base class per context makes it possible for the
 * application layer to catch all payment-domain failures with one
 * `instanceof` check while still distinguishing them from infrastructure
 * errors (network, database) by their `DomainError` ancestry.
 */
export abstract class PaymentDomainError extends DomainError {}

/**
 * Thrown when a payment-status transition violates the state machine,
 * e.g. attempting to mark an intent as SUCCEEDED directly from INITIATED,
 * or mutating an intent that already reached a terminal state.
 *
 * This is a domain invariant failure, not a runtime accident — callers must
 * treat it as "the command was illegal", never retry it.
 */
export class IllegalPaymentStatusTransitionError extends PaymentDomainError {
  readonly code = 'ILLEGAL_PAYMENT_STATUS_TRANSITION';

  constructor(
    readonly from: string,
    readonly to: string,
  ) {
    super(`Illegal payment status transition: ${from} → ${to}`);
  }
}

/**
 * Thrown when {@link PaymentRouter} cannot find any provider capable of
 * handling the requested currency/method combination.
 *
 * Carries a human-readable `reason` for logs; the caller decides whether to
 * surface it to the client (usually a 422-style "unsupported payment
 * combination") or fall back to an alternative method.
 */
export class RoutingFailedError extends PaymentDomainError {
  readonly code = 'PAYMENT_ROUTING_FAILED';

  constructor(readonly reason: string) {
    super(`Payment routing failed: ${reason}`);
  }
}

/**
 * Thrown when a {@link PaymentIntent} is constructed or mutated with
 * inconsistent data (zero amount, missing provider, empty reference, ...).
 */
export class InvalidPaymentIntentError extends PaymentDomainError {
  readonly code = 'INVALID_PAYMENT_INTENT';

  constructor(reason: string) {
    super(`Invalid payment intent: ${reason}`);
  }
}

/**
 * Thrown when a refund would push the total refunded amount above the
 * originally charged amount. This is the Payments-context twin of the
 * escrow "released + refunded ≤ held" invariant.
 */
export class RefundExceedsChargedAmountError extends PaymentDomainError {
  readonly code = 'REFUND_EXCEEDS_CHARGED_AMOUNT';

  constructor(
    readonly chargedAmount: number,
    readonly alreadyRefunded: number,
    readonly requestedRefund: number,
  ) {
    super(
      `Refund of ${requestedRefund} minor units would exceed the charged amount ` +
        `(${chargedAmount}); already refunded: ${alreadyRefunded}`,
    );
  }
}

/**
 * Thrown when a refund is requested while the intent is not in the SUCCEEDED
 * state. We only ever refund settled money — a refund against a FAILED or
 * still-PROCESSING intent would mean reversing funds we never confirmed
 * receiving (webhook-confirmed settlement only).
 */
export class RefundNotAllowedError extends PaymentDomainError {
  readonly code = 'REFUND_NOT_ALLOWED';

  constructor(currentStatus: string) {
    super(
      `Refunds are only allowed on SUCCEEDED payments; current status is ${currentStatus}`,
    );
  }
}
