import { timingSafeEqual } from 'node:crypto';

import type { ZodType } from 'zod';

import { NormalizedPaymentEvent } from '../../domain/normalized-payment-event';
import type { ProviderWebhookPort } from '../../application/ports/provider-webhook.port';
import {
  InvalidProviderPayloadError,
  InvalidWebhookSignatureError,
  UnrecognizedProviderEventError,
} from '../../application/errors';
import type { DomainError } from '../../../shared/kernel/domain-error';
import { err, ok, type Result } from '../../../shared/kernel/result';
import { Money } from '../../../shared/kernel/money';
import {
  flutterwaveChargeCompletedSchema,
  flutterwaveRefundSchema,
  flutterwaveTransferCompletedSchema,
  type FlutterwaveChargeCompleted,
  type FlutterwaveRefund,
  type FlutterwaveTransferCompleted,
} from './flutterwave-webhook.schemas';

/**
 * Flutterwave webhook adapter: secret-hash verification (per
 * [Flutterwave's webhook docs](https://developer.flutterwave.com/docs/webhooks.md))
 * plus normalization to {@link NormalizedPaymentEvent}.
 *
 * Event-mapping decisions (verified against current docs, 2026-09):
 *
 *  - `charge.completed` + `status: successful` → CHARGE_SUCCEEDED.
 *  - `charge.completed` + `status: failed` → CHARGE_FAILED, with
 *    `processor_response` as the failure reason. This is the provider that
 *    finally justifies the internal CHARGE_FAILED enum entry — Paystack emits
 *    no failed-charge event; Flutterwave folds both outcomes into ONE event
 *    name and disambiguates on the status field (lowercase `successful` /
 *    `failed`, strictly validated by the schema — anything else is rejected,
 *    never guessed at).
 *  - `transfer.completed` + `status: SUCCESSFUL|FAILED` → TRANSFER_COMPLETED /
 *    TRANSFER_FAILED. Note the UPPERCASE transfer statuses versus lowercase
 *    charge statuses — verified inconsistency in the official docs samples,
 *    encoded as two strict enums in the schema.
 *  - The refund webhook is a DIFFERENT SHAPE entirely: no `event` field, a
 *    flat object with Capitalized keys (`AmountRefunded`, `FlwRef`,
 *    `TransactionId`). Detected by the absence of `event`, then proven by
 *    {@link flutterwaveRefundSchema} before mapping to REFUND_COMPLETED.
 *    `providerRef` is `TransactionId` (the original Flutterwave transaction) —
 *    see the caveat on {@link refund} below.
 *  - Everything else Flutterwave emits (`subscription.cancelled`,
 *    `bvn.completed`, `singlebillpayment.status`, virtual card debits/OTPs,
 *    PSA inflows) is REJECTED as unmapped — logged loudly, never guessed at.
 *
 * Dedup key: Flutterwave retries (3 attempts, 30-minute intervals, if enabled
 * in the dashboard) resend byte-identical payloads, and one transaction can
 * legitimately emit `charge.completed` more than once as its status evolves.
 * Flutterwave's own idempotency guidance keys on id + status. So the internal
 * eventId is `flutterwave:{providerId}:{event}:{status}` — stable across
 * retries of the same logical delivery, distinct across status changes.
 * Refund payloads carry no status variants (only `completed` is accepted), so
 * `flutterwave:refund:{refundId}` suffices.
 *
 * Signature scheme, and its honest weakness: Flutterwave does NOT HMAC the
 * body. The dashboard-configured secret hash is sent verbatim in the
 * `verif-hash` header and compared for equality. Anyone who learns the hash
 * can forge webhooks, so the hash must be treated with secret-key discipline
 * (env-injected, never committed, rotated in the dashboard if leaked). The
 * comparison still uses `timingSafeEqual` — a naive `===` on strings leaks
 * the hash byte-by-byte through response timing. (Not HMAC also means the
 * raw body is not an input to verification, but we still require it intact
 * for schema validation and the audit trail.)
 *
 * Amounts arrive in MAJOR units (naira, not kobo) as JSON number OR string,
 * and the docs show float fees — so all conversion runs through
 * {@link Money.fromMajorUnits} (decimal-based, half-up at the boundary).
 * `charged_amount` (what actually moved) is preferred over `amount` (what was
 * intended) when present; failed charges only carry `amount`.
 *
 * The secret hash is a CONSTRUCTOR argument: the composition root reads it
 * from the environment (FLUTTERWAVE_SECRET_HASH); the adapter never touches
 * process.env itself.
 */
export class FlutterwaveWebhookAdapter implements ProviderWebhookPort {
  readonly provider = 'flutterwave';

  constructor(private readonly secretHash: string) {}

  verifyAndNormalizeWebhook(
    rawBody: Buffer,
    headers: Record<string, string | string[] | undefined>,
  ): Promise<Result<NormalizedPaymentEvent, DomainError>> {
    // Verification and normalization are synchronous; the port is async
    // because other providers may need async steps. Wrapping keeps the
    // interface uniform (same stance as the Paystack adapter).
    return Promise.resolve(this.verifyAndNormalizeSync(rawBody, headers));
  }

  private verifyAndNormalizeSync(
    rawBody: Buffer,
    headers: Record<string, string | string[] | undefined>,
  ): Result<NormalizedPaymentEvent, DomainError> {
    // 1. Signature FIRST — origin before shape, always.
    const signatureError = this.verifySignature(headers);
    if (signatureError) return err(signatureError);

    // 2. Parse, then dispatch: a string `event` field picks the schema;
    //    NO event field means the only legitimate shape is a refund payload,
    //    which the refund schema must then prove.
    let parsed: { event?: unknown };
    try {
      parsed = JSON.parse(rawBody.toString('utf8')) as { event?: unknown };
    } catch {
      return err(
        new InvalidProviderPayloadError(
          this.provider,
          'body is not valid JSON',
        ),
      );
    }

    if (typeof parsed.event === 'string') {
      switch (parsed.event) {
        case 'charge.completed':
          return this.normalize(
            flutterwaveChargeCompletedSchema,
            rawBody,
            (body) => this.chargeCompleted(body),
          );
        case 'transfer.completed':
          return this.normalize(
            flutterwaveTransferCompletedSchema,
            rawBody,
            (body) => this.transferCompleted(body),
          );
        default:
          return err(
            new UnrecognizedProviderEventError(this.provider, parsed.event),
          );
      }
    }

    // No `event` field: accepted ONLY if the payload exactly matches the
    // refund shape. A no-event body that fails the refund schema (e.g. a
    // virtual-card debit, which also uses Capitalized keys) is an invalid
    // payload, not an unmapped event — we can name what we expected.
    const asRefund = flutterwaveRefundSchema.safeParse(parsed);
    if (!asRefund.success) {
      return err(
        new InvalidProviderPayloadError(
          this.provider,
          'payload has no event field and does not match the refund shape: ' +
            JSON.stringify(asRefund.error.issues),
        ),
      );
    }
    return ok(this.refund(asRefund.data));
  }

  // ------------------------------------------------------------------ //
  // Signature verification                                            //
  // ------------------------------------------------------------------ //

  /**
   * Compares the `verif-hash` header against the dashboard-configured secret
   * hash using a constant-time comparison. Length mismatch fails closed
   * without calling timingSafeEqual (it would throw).
   */
  private verifySignature(
    headers: Record<string, string | string[] | undefined>,
  ): DomainError | null {
    const header = headers['verif-hash'];
    const received = Array.isArray(header) ? header[0] : header;
    if (!received) {
      return new InvalidWebhookSignatureError(
        this.provider,
        'verif-hash header missing',
      );
    }

    const expectedBuffer = Buffer.from(this.secretHash, 'utf8');
    const receivedBuffer = Buffer.from(received, 'utf8');
    if (
      expectedBuffer.length !== receivedBuffer.length ||
      !timingSafeEqual(expectedBuffer, receivedBuffer)
    ) {
      return new InvalidWebhookSignatureError(
        this.provider,
        'secret hash mismatch',
      );
    }
    return null;
  }

  // ------------------------------------------------------------------ //
  // Normalization                                                     //
  // ------------------------------------------------------------------ //

  /**
   * Schema-validate then map. The mapping step can still fail on values the
   * schema cannot judge — e.g. an amount that is well-formed JSON but not
   * convertible to minor units, or a 3-letter currency code ISO doesn't
   * know. Those become {@link InvalidProviderPayloadError}, never thrown
   * exceptions escaping the port.
   */
  private normalize<T>(
    schema: ZodType<T>,
    rawBody: Buffer,
    map: (body: T) => NormalizedPaymentEvent,
  ): Result<NormalizedPaymentEvent, DomainError> {
    let json: unknown;
    try {
      json = JSON.parse(rawBody.toString('utf8'));
    } catch {
      return err(
        new InvalidProviderPayloadError(
          this.provider,
          'body is not valid JSON',
        ),
      );
    }
    const parsed = schema.safeParse(json);
    if (!parsed.success) {
      return err(
        new InvalidProviderPayloadError(
          this.provider,
          JSON.stringify(parsed.error.issues),
        ),
      );
    }
    try {
      return ok(map(parsed.data));
    } catch (error) {
      return err(
        new InvalidProviderPayloadError(
          this.provider,
          error instanceof Error ? error.message : String(error),
        ),
      );
    }
  }

  /**
   * Converts a major-unit webhook amount to integer minor units via the
   * domain's decimal-based {@link Money.fromMajorUnits}. Never `Number()`
   * math: Flutterwave payloads contain floats (fees especially) and the whole
   * point of the Money convention is that floats never touch money here.
   */
  private toMinorUnits(amount: number | string, currency: string): number {
    return Money.fromMajorUnits(String(amount), currency).amount;
  }

  private chargeCompleted(
    body: FlutterwaveChargeCompleted,
  ): NormalizedPaymentEvent {
    const { data } = body;
    const succeeded = data.status === 'successful';
    // `charged_amount` is what actually moved and is present on successful
    // charges; failed charges carry only the intended `amount`.
    const majorAmount = data.charged_amount ?? data.amount;
    const currency = data.currency.toUpperCase();
    return new NormalizedPaymentEvent({
      eventId: `flutterwave:${data.id}:charge.completed:${data.status}`,
      provider: 'flutterwave',
      type: succeeded ? 'CHARGE_SUCCEEDED' : 'CHARGE_FAILED',
      // `tx_ref` is OUR reference from charge initiation — the key our
      // PaymentIntent is looked up by. (`flw_ref` is the provider-side id.)
      providerRef: data.tx_ref,
      occurredAt: new Date(data.created_at),
      amountMinor: this.toMinorUnits(majorAmount, currency),
      currency,
      failureReason: succeeded
        ? undefined
        : (data.processor_response ?? 'charge failed'),
      raw: body,
    });
  }

  private transferCompleted(
    body: FlutterwaveTransferCompleted,
  ): NormalizedPaymentEvent {
    const { data } = body;
    const succeeded = data.status === 'SUCCESSFUL';
    const currency = data.currency.toUpperCase();
    return new NormalizedPaymentEvent({
      eventId: `flutterwave:${data.id}:transfer.completed:${data.status}`,
      provider: 'flutterwave',
      type: succeeded ? 'TRANSFER_COMPLETED' : 'TRANSFER_FAILED',
      providerRef: data.reference,
      occurredAt: new Date(data.created_at),
      amountMinor: this.toMinorUnits(data.amount, currency),
      currency,
      failureReason: succeeded
        ? undefined
        : (data.complete_message ?? 'transfer failed'),
      raw: body,
    });
  }

  /**
   * Refund events anchor to the ORIGINAL charge via `TransactionId` — the
   * Flutterwave transaction id we learn when we verify the charge (or from
   * the `data.id` of its `charge.completed`). CAVEAT, flagged for
   * ratification: this is NOT our `tx_ref`, so refund reconciliation
   * requires the (future) charge-verification flow to persist the flw
   * transaction id on the PaymentIntent. When the refund INITIATION API is
   * built, revisit whether we should instead key refunds off a reference we
   * supply in the refund request's `meta`.
   */
  private refund(body: FlutterwaveRefund): NormalizedPaymentEvent {
    return new NormalizedPaymentEvent({
      eventId: `flutterwave:refund:${body.id}`,
      provider: 'flutterwave',
      type: 'REFUND_COMPLETED',
      providerRef: String(body.TransactionId),
      occurredAt: new Date(body.createdAt),
      // The documented refund shape carries NO currency field, and the event
      // contract forbids an amount without a currency — so refunds normalize
      // with no amount. Amount reconciliation for refunds is deferred to the
      // (future) refund-initiation flow, which knows the original charge's
      // currency.
      raw: body,
    });
  }
}
