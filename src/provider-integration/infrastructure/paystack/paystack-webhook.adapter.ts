import { createHmac, timingSafeEqual } from 'node:crypto';

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
import {
  paystackChargeSuccessSchema,
  paystackRefundProcessedSchema,
  paystackTransferSchema,
  type PaystackChargeSuccess,
  type PaystackRefundProcessed,
  type PaystackTransfer,
} from './paystack-webhook.schemas';

/**
 * Paystack webhook adapter: HMAC-SHA512 signature verification (per
 * [Paystack's webhook docs](https://paystack.com/docs/payments/webhooks/))
 * plus normalization to {@link NormalizedPaymentEvent}.
 *
 * Event-mapping decisions (verified against current docs, 2026-09):
 *
 *  - `charge.success` → CHARGE_SUCCEEDED. Note there is intentionally NO
 *    `charge.failed` mapping: Paystack does not emit a failed-charge event;
 *    failures surface via the verification API or disputes. The internal
 *    CHARGE_FAILED enum entry exists for providers that do (e.g.
 *    Flutterwave) — mapping a nonexistent event would be fiction.
 *  - `transfer.success` → TRANSFER_COMPLETED; `transfer.failed` and
 *    `transfer.reversed` → TRANSFER_FAILED (reversal IS a failure of the
 *    transfer to stay settled — the escrow handler treats both as "funds
 *    did not arrive").
 *  - `refund.processed` → REFUND_COMPLETED. `refund.failed` /
 *    `refund.pending` / `refund.processing` are REJECTED as unmapped:
 *    there is no internal enum entry for them yet, and a refund we cannot
 *    confirm must not transition any state.
 *  - Dispute events (`charge.dispute.create`, ...) are REJECTED as unmapped
 *    for now. Escrow dispute handling is internal; wiring provider disputes
 *    to it is a deliberate future change.
 *
 * Dedup key: Paystack retries resend identical payloads with no per-delivery
 * event id, so the internal eventId is `paystack:{transactionId}:{event}` —
 * stable across retries of the same logical event, unique across events.
 *
 * The secret key is a CONSTRUCTOR argument: the composition root reads it
 * from the environment (PAYSTACK_SECRET_KEY); the adapter never touches
 * process.env itself.
 */
export class PaystackWebhookAdapter implements ProviderWebhookPort {
  readonly provider = 'paystack';

  constructor(private readonly secretKey: string) {}

  verifyAndNormalizeWebhook(
    rawBody: Buffer,
    headers: Record<string, string | string[] | undefined>,
  ): Promise<Result<NormalizedPaymentEvent, DomainError>> {
    // HMAC verification is synchronous CPU-bound crypto; the port is async
    // because other providers may need async steps (e.g. remote key
    // rotation checks). Wrapping keeps the interface uniform.
    return Promise.resolve(this.verifyAndNormalizeSync(rawBody, headers));
  }

  private verifyAndNormalizeSync(
    rawBody: Buffer,
    headers: Record<string, string | string[] | undefined>,
  ): Result<NormalizedPaymentEvent, DomainError> {
    // 1. Signature FIRST — origin before shape, always.
    const signatureError = this.verifySignature(rawBody, headers);
    if (signatureError) return err(signatureError);

    // 2. Parse + dispatch on the event name, then schema-validate.
    let parsed: { event?: string };
    try {
      parsed = JSON.parse(rawBody.toString('utf8')) as { event?: string };
    } catch {
      return err(
        new InvalidProviderPayloadError(
          this.provider,
          'body is not valid JSON',
        ),
      );
    }

    switch (parsed.event) {
      case 'charge.success':
        return this.normalize(paystackChargeSuccessSchema, rawBody, (body) =>
          this.chargeSuccess(body),
        );
      case 'transfer.success':
      case 'transfer.failed':
      case 'transfer.reversed':
        return this.normalize(paystackTransferSchema, rawBody, (body) =>
          this.transfer(body),
        );
      case 'refund.processed':
        return this.normalize(paystackRefundProcessedSchema, rawBody, (body) =>
          this.refundProcessed(body),
        );
      default:
        return err(
          new UnrecognizedProviderEventError(
            this.provider,
            String(parsed.event ?? 'unknown'),
          ),
        );
    }
  }

  // ------------------------------------------------------------------ //
  // Signature verification                                            //
  // ------------------------------------------------------------------ //

  private verifySignature(
    rawBody: Buffer,
    headers: Record<string, string | string[] | undefined>,
  ): DomainError | null {
    const header = headers['x-paystack-signature'];
    const received = Array.isArray(header) ? header[0] : header;
    if (!received) {
      return new InvalidWebhookSignatureError(
        this.provider,
        'x-paystack-signature header missing',
      );
    }

    const expected = createHmac('sha512', this.secretKey)
      .update(rawBody)
      .digest('hex');
    const expectedBuffer = Buffer.from(expected, 'hex');
    const receivedBuffer = Buffer.from(received, 'hex');
    // timingSafeEqual throws on length mismatch — that is also a failure,
    // just not a timing leak.
    if (
      expectedBuffer.length !== receivedBuffer.length ||
      !timingSafeEqual(expectedBuffer, receivedBuffer)
    ) {
      return new InvalidWebhookSignatureError(
        this.provider,
        'signature mismatch',
      );
    }
    return null;
  }

  // ------------------------------------------------------------------ //
  // Normalization                                                     //
  // ------------------------------------------------------------------ //

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
    return ok(map(parsed.data));
  }

  private chargeSuccess(body: PaystackChargeSuccess): NormalizedPaymentEvent {
    const { data } = body;
    return new NormalizedPaymentEvent({
      eventId: `paystack:${data.id}:${body.event}`,
      provider: 'paystack',
      type: 'CHARGE_SUCCEEDED',
      providerRef: data.reference,
      occurredAt: new Date(data.paid_at * 1000),
      amountMinor: data.amount,
      currency: data.currency.toUpperCase(),
      raw: body,
    });
  }

  private transfer(body: PaystackTransfer): NormalizedPaymentEvent {
    const { data } = body;
    const failed = body.event !== 'transfer.success';
    return new NormalizedPaymentEvent({
      eventId: `paystack:${data.id}:${body.event}`,
      provider: 'paystack',
      type: failed ? 'TRANSFER_FAILED' : 'TRANSFER_COMPLETED',
      providerRef: data.reference,
      occurredAt: new Date(data.created_at * 1000),
      amountMinor: data.amount,
      currency: data.currency.toUpperCase(),
      failureReason:
        body.event === 'transfer.reversed'
          ? 'transfer reversed'
          : (data.reason ?? (failed ? 'transfer failed' : undefined)),
      raw: body,
    });
  }

  private refundProcessed(
    body: PaystackRefundProcessed,
  ): NormalizedPaymentEvent {
    const { data } = body;
    return new NormalizedPaymentEvent({
      eventId: `paystack:${data.id}:${body.event}`,
      provider: 'paystack',
      type: 'REFUND_COMPLETED',
      // Anchored to the original charge so the refund reconciles to the intent.
      providerRef: data.transaction.reference,
      occurredAt: new Date(data.created_at * 1000),
      amountMinor: data.amount,
      currency: data.currency.toUpperCase(),
      raw: body,
    });
  }
}
