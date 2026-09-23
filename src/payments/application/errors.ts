import { DomainError } from '../../shared/kernel/domain-error';

/**
 * Thrown when a duplicate command arrives while the original is still being
 * processed (its idempotency key is held in 'in-progress' by another
 * request). This is NOT a failure of either request — the client should
 * retry shortly, at which point the original will either be complete
 * (replay returns its result) or released (the new attempt executes).
 *
 * Distinct from a conflict error: nothing about the request is wrong.
 */
export class RequestInProgressError extends DomainError {
  readonly code = 'REQUEST_IN_PROGRESS';

  constructor(
    readonly scope: string,
    readonly idempotencyKey: string,
  ) {
    super(
      `A request with idempotency key ${idempotencyKey} is already in progress`,
    );
  }
}

/**
 * Thrown when a webhook references a provider charge this service has no
 * internal intent for. Possible causes: an event for a charge created
 * outside this service, a stale pre-launch event, or (worth investigating)
 * an intent that failed to persist. We reject rather than guess — silently
 * ignoring would hide reconciliation gaps.
 */
export class UnknownProviderReferenceError extends DomainError {
  readonly code = 'UNKNOWN_PROVIDER_REFERENCE';

  constructor(
    readonly provider: string,
    readonly providerRef: string,
  ) {
    super(`No payment intent found for ${provider} reference ${providerRef}`);
  }
}

/**
 * Thrown when a CHARGE_SUCCEEDED webhook's amount/currency disagrees with
 * the internal intent it reconciles to. This should essentially never
 * happen; when it does, it means either a serious provider anomaly or that
 * we reconciled to the wrong intent. Either way the correct response is to
 * STOP and surface it, never to book the webhook's numbers over ours.
 */
export class WebhookAmountMismatchError extends DomainError {
  readonly code = 'WEBHOOK_AMOUNT_MISMATCH';

  constructor(
    readonly providerRef: string,
    readonly webhookAmount: string,
    readonly intentAmount: string,
  ) {
    super(
      `Webhook amount ${webhookAmount} for ${providerRef} does not match intent amount ${intentAmount}`,
    );
  }
}

/**
 * Thrown when a normalized event of a known type reaches a handler that
 * does not (yet) handle that type — e.g. TRANSFER_* events arriving at the
 * Payments handler, which belongs to the Escrow context. Explicitly loud so
 * an unhandled event type becomes a deployment-visible error instead of a
 * silently dropped webhook.
 */
export class UnsupportedEventTypeError extends DomainError {
  readonly code = 'UNSUPPORTED_EVENT_TYPE';

  constructor(eventType: string, handler: string) {
    super(`Event type ${eventType} is not handled by ${handler}`);
  }
}
