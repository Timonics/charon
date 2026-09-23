import { DomainError } from '../../shared/kernel/domain-error';

/**
 * Thrown when a webhook's signature header is missing, malformed, or does
 * not match the HMAC of the raw body. The event is untrusted: it must be
 * rejected before the body is even parsed.
 */
export class InvalidWebhookSignatureError extends DomainError {
  readonly code = 'INVALID_WEBHOOK_SIGNATURE';

  constructor(provider: string, reason: string) {
    super(`Invalid ${provider} webhook signature: ${reason}`);
  }
}

/**
 * Thrown when a webhook carries a recognized provider event type that this
 * adapter does not map to an internal event — e.g. Paystack's
 * `refund.failed` or `charge.dispute.create`, for which the internal enum
 * has no entry yet. Logged and rejected, NEVER guessed at: a half-mapped
 * event is worse than an unmapped one, because it looks handled.
 *
 * The fix for this error is always a code change: extend the enum, write
 * the handling, then add the mapping.
 */
export class UnrecognizedProviderEventError extends DomainError {
  readonly code = 'UNRECOGNIZED_PROVIDER_EVENT';

  constructor(
    readonly provider: string,
    readonly eventType: string,
  ) {
    super(`${provider} event "${eventType}" has no internal mapping; rejected`);
  }
}

/**
 * Thrown when a webhook passes signature verification but its body does not
 * match the expected schema. Signature proves origin, not shape — a real
 * Paystack event with an unexpected payload (field renamed, structure
 * changed) must fail validation here rather than produce a malformed
 * NormalizedPaymentEvent downstream.
 */
export class InvalidProviderPayloadError extends DomainError {
  readonly code = 'INVALID_PROVIDER_PAYLOAD';

  constructor(provider: string, issues: string) {
    super(`Invalid ${provider} webhook payload: ${issues}`);
  }
}

/**
 * Thrown when a provider API call got a RESPONSE but the response says the
 * operation failed: non-2xx status, or a success-shaped HTTP 200 carrying a
 * business-level failure envelope (Paystack's `{ status: false }`,
 * Flutterwave's `{ status: "error" }`, Stripe's `{ error: { ... } }`).
 *
 * Transport-level failure (no response at all) is a DIFFERENT error —
 * {@link HttpTransportError} — because the operational response differs:
 * unreachable provider means retry later; a provider refusal means do not
 * blindly retry without understanding why.
 *
 * `message` is sanitized by the adapter before construction: it comes from
 * the provider's error envelope or status line, never from request material
 * (which could echo the Authorization header).
 */
export class ProviderApiError extends DomainError {
  readonly code = 'PROVIDER_API_ERROR';

  constructor(
    readonly provider: string,
    readonly operation: string,
    message: string,
  ) {
    super(`${provider} ${operation} failed: ${message}`);
  }
}
