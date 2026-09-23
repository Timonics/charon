import type { NormalizedPaymentEvent } from '../../domain/normalized-payment-event';
import type { Result } from '../../../shared/kernel/result';
import type { DomainError } from '../../../shared/kernel/domain-error';

/**
 * The webhook half of the provider port. Each provider adapter implements
 * signature verification (per its own scheme) and normalization to the one
 * internal {@link NormalizedPaymentEvent} shape in a single call, because
 * those two steps must never be separable — there is no legitimate way to
 * normalize an unverified body.
 *
 * The charge/transfer/refund initiation half of the provider port arrives
 * with the provider-API increment; it will be a separate interface so that
 * webhook handling can be deployed and tested independently.
 */
export interface ProviderWebhookPort {
  /** Human/provider identifier for logs and error messages. */
  readonly provider: string;

  /**
   * @param rawBody  the EXACT request bytes as received — signature schemes
   *                 are computed over raw bytes; a re-serialized JSON body
   *                 will fail verification.
   * @param headers  the request headers (case-insensitive lookup is the
   *                 adapter's job).
   */
  verifyAndNormalizeWebhook(
    rawBody: Buffer,
    headers: Record<string, string | string[] | undefined>,
  ): Promise<Result<NormalizedPaymentEvent, DomainError>>;
}
