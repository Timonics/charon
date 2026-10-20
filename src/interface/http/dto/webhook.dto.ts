/**
 * HTTP DTOs for the webhook surface.
 *
 * Inbound: the webhook body is NOT a DTO. The webhook controller
 * reads `req.rawBody` (the exact bytes captured by
 * RawBodyMiddleware) and hands it to the provider-specific
 * `ProviderWebhookPort.verifyAndNormalizeWebhook`. Verifying
 * the signature against the exact byte stream is the entire
 * point — re-serializing the body as JSON would invalidate
 * the signature.
 *
 * Outbound: the response is the small `WebhookHandlingResponseDto`
 * below. Paystack, Stripe, and Flutterwave don't actually read
 * the response body, but the provider's webhook
 * infrastructure will retry on a non-2xx, so we send a
 * structured 200 with the outcome (APPLIED / DUPLICATE_IGNORED
 * / ALREADY_IN_TARGET_STATE) for log-friendly observability.
 */
export type WebhookOutcome =
  'APPLIED' | 'DUPLICATE_IGNORED' | 'ALREADY_IN_TARGET_STATE';

export class WebhookHandlingResponseDto {
  outcome!: WebhookOutcome;
  intentId?: string;

  static from(result: {
    readonly outcome: WebhookOutcome;
    readonly intentId?: string;
  }): WebhookHandlingResponseDto {
    const dto = new WebhookHandlingResponseDto();
    dto.outcome = result.outcome;
    if (result.intentId !== undefined) {
      dto.intentId = result.intentId;
    }
    return dto;
  }
}
