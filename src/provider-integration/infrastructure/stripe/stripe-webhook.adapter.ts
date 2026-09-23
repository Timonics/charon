import { createHmac, timingSafeEqual } from 'node:crypto';

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
  stripeWebhookEventSchema,
  type StripeWebhookEvent,
} from './stripe-webhook.schemas';

/** Default replay-protection window, mirroring stripe-node's DEFAULT_TOLERANCE. */
const DEFAULT_TOLERANCE_SECONDS = 300;

/**
 * Stripe webhook adapter: timestamped-HMAC verification (per
 * [Stripe's docs](https://docs.stripe.com/webhooks/signature) and the
 * reference implementation in stripe-node's Webhooks.ts) plus normalization
 * to {@link NormalizedPaymentEvent}.
 *
 * Signature scheme (verified against stripe-node source, 2026-09):
 *
 *  - `Stripe-Signature` header: comma-separated `k=v` pairs —
 *    `t={unixSeconds},v1={hex}` (a legacy `v0` entry may also appear and is
 *    ignored, per Stripe's own parser).
 *  - Signed content: the UTF-8 string `{timestamp}.{rawBody}` — the raw body
 *    is part of the signed material, so the adapter requires the exact
 *    request bytes (the port contract already mandates this).
 *  - The HMAC key is the endpoint secret VERBATIM (the `whsec_...` string),
 *    with no decoding step — this matches stripe-node's
 *    `computeHMACSignature(payload, secret)`.
 *  - MULTIPLE `v1` entries may be present: Stripe signs with both the old
 *    and new secret during rotation, and ANY match accepts. The expected
 *    signature is compared against every candidate with
 *    `timingSafeEqual` (constant-time; length mismatch fails closed).
 *  - Replay protection: the event `t` must not be older than the tolerance
 *    window (default 300s, Stripe's own default). Mirrors Stripe's check,
 *    which rejects only STALE timestamps (a clock-ahead event still
 *    verifies — acceptable because a forger who knows the secret is not the
 *    threat model here).
 *
 * Event mapping and the transfer-vocabulary caveat (flagged for
 * ratification): Stripe has NO `transfer.paid` event — Connect transfers do
 * not emit settlement webhooks. Outbound-money settlement over Stripe
 * surfaces as PAYOUT events, so `payout.paid` → TRANSFER_COMPLETED and
 * `payout.failed` → TRANSFER_FAILED (the escrow release flow will initiate
 * payouts/transfers when we build the charge/transfer APIs, and this mapping
 * assumes payout semantics there — revisit if escrow release uses a
 * different Stripe primitive). `charge.succeeded` / `charge.failed` map to
 * CHARGE_SUCCEEDED / CHARGE_FAILED with `payment_intent` as the
 * reconciliation key: this service will always charge through the
 * PaymentIntent API, so `payment_intent` is the id our PaymentIntent row
 * will store at initiation. `charge.refunded` → REFUND_COMPLETED anchored
 * to that same payment_intent, with `amount_refunded` (total refunded on
 * the charge) as the amount — note this is cumulative, so partial refunds
 * each emit the new cumulative total. Everything else Stripe emits
 * (`payment_intent.*`, `charge.dispute.*`, `payout.updated`, ...) is
 * REJECTED as unmapped — logged loudly, never guessed at.
 *
 * Dedup key: Stripe events carry a first-class `id` (evt_...) that is unique
 * per logical event and STABLE across Stripe's retries — no field-composition
 * heuristic needed, unlike Paystack (`{id}:{event}`) and Flutterwave
 * (`{id}:{event}:{status}`). The internal eventId is simply `stripe:{id}`.
 *
 * Amounts need NO conversion here: Stripe uses integer minor units (cents)
 * natively, enforced by the schema. Only currency codes are lowercased by
 * Stripe and uppercased by the adapter.
 *
 * `now` and `toleranceSeconds` are injectable for deterministic contract
 * tests; the composition root defaults them to `Date.now` and 300s. The
 * endpoint secret is a CONSTRUCTOR argument (STRIPE_WEBHOOK_SECRET from the
 * environment at the composition root); the adapter never touches
 * process.env itself.
 */
export class StripeWebhookAdapter implements ProviderWebhookPort {
  readonly provider = 'stripe';

  private readonly now: () => number;
  private readonly toleranceSeconds: number;

  constructor(
    private readonly webhookSecret: string,
    options?: { now?: () => number; toleranceSeconds?: number },
  ) {
    this.now = options?.now ?? Date.now;
    this.toleranceSeconds =
      options?.toleranceSeconds ?? DEFAULT_TOLERANCE_SECONDS;
  }

  verifyAndNormalizeWebhook(
    rawBody: Buffer,
    headers: Record<string, string | string[] | undefined>,
  ): Promise<Result<NormalizedPaymentEvent, DomainError>> {
    // HMAC verification is synchronous CPU-bound crypto; the port is async
    // for interface uniformity (same stance as the other provider adapters).
    return Promise.resolve(this.verifyAndNormalizeSync(rawBody, headers));
  }

  private verifyAndNormalizeSync(
    rawBody: Buffer,
    headers: Record<string, string | string[] | undefined>,
  ): Result<NormalizedPaymentEvent, DomainError> {
    // 1. Signature FIRST — origin before shape, always.
    const signatureError = this.verifySignature(rawBody, headers);
    if (signatureError) return err(signatureError);

    // 2. Schema-validate the event envelope. The discriminated union on
    //    `type` rejects unmapped event types AND mistyped payloads with one
    //    parse; the error text distinguishes them for the log.
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
    const parsed = stripeWebhookEventSchema.safeParse(json);
    if (!parsed.success) {
      // A structurally valid envelope whose `type` we do not map is an
      // UNMAPPED EVENT, not a malformed payload — distinguish the two so
      // the log says "add a mapping" instead of "fix the payload".
      const type = (json as { type?: unknown }).type;
      if (typeof type === 'string' && this.isUnmappedType(type)) {
        return err(new UnrecognizedProviderEventError(this.provider, type));
      }
      return err(
        new InvalidProviderPayloadError(
          this.provider,
          JSON.stringify(parsed.error.issues),
        ),
      );
    }

    return ok(this.toNormalizedEvent(parsed.data));
  }

  /** The event types the schema deliberately maps. */
  private static readonly MAPPED_TYPES = new Set([
    'charge.succeeded',
    'charge.failed',
    'charge.refunded',
    'payout.paid',
    'payout.failed',
  ]);

  private isUnmappedType(type: string): boolean {
    return !StripeWebhookAdapter.MAPPED_TYPES.has(type);
  }

  // ------------------------------------------------------------------ //
  // Signature verification                                            //
  // ------------------------------------------------------------------ //

  /**
   * Parses the `Stripe-Signature` header, recomputes the expected HMAC over
   * `{timestamp}.{rawBody}`, and requires a constant-time match against at
   * least one `v1` candidate. Mirrors stripe-node's verifyHeader: missing
   * timestamp or no v1 entries fails; stale timestamps fail when older than
   * the tolerance window.
   */
  private verifySignature(
    rawBody: Buffer,
    headers: Record<string, string | string[] | undefined>,
  ): DomainError | null {
    const header = headers['stripe-signature'];
    const headerValue = Array.isArray(header) ? header[0] : header;
    if (!headerValue) {
      return new InvalidWebhookSignatureError(
        this.provider,
        'stripe-signature header missing',
      );
    }

    // Parse comma-separated k=v pairs. Stripe may send several v1 entries
    // during secret rotation; all are candidates.
    let timestamp = -1;
    const candidates: string[] = [];
    for (const pair of headerValue.split(',')) {
      const eq = pair.indexOf('=');
      if (eq === -1) continue;
      const key = pair.slice(0, eq).trim();
      const value = pair.slice(eq + 1).trim();
      if (key === 't') timestamp = Number.parseInt(value, 10);
      if (key === 'v1') candidates.push(value);
    }

    if (timestamp === -1 || Number.isNaN(timestamp)) {
      return new InvalidWebhookSignatureError(
        this.provider,
        'signature header has no valid timestamp (t=...)',
      );
    }
    if (candidates.length === 0) {
      return new InvalidWebhookSignatureError(
        this.provider,
        'signature header has no v1 signatures',
      );
    }

    // Replay protection: reject events older than the tolerance window
    // (mirrors stripe-node's `timestampAge > tolerance` check).
    const ageSeconds = Math.floor(this.now() / 1000) - timestamp;
    if (ageSeconds > this.toleranceSeconds) {
      return new InvalidWebhookSignatureError(
        this.provider,
        `timestamp outside the ${this.toleranceSeconds}s tolerance window (event is ${ageSeconds}s old)`,
      );
    }

    const expected = createHmac('sha256', this.webhookSecret)
      .update(`${timestamp}.${rawBody.toString('utf8')}`)
      .digest('hex');
    const expectedBuffer = Buffer.from(expected, 'hex');

    const matches = candidates.some((candidate) => {
      const candidateBuffer = Buffer.from(candidate, 'hex');
      // timingSafeEqual throws on length mismatch — that is also a failure,
      // just not a timing leak.
      return (
        candidateBuffer.length === expectedBuffer.length &&
        timingSafeEqual(expectedBuffer, candidateBuffer)
      );
    });
    if (!matches) {
      return new InvalidWebhookSignatureError(
        this.provider,
        'no v1 signature matches the expected HMAC',
      );
    }
    return null;
  }

  // ------------------------------------------------------------------ //
  // Normalization                                                     //
  // ------------------------------------------------------------------ //

  private toNormalizedEvent(event: StripeWebhookEvent): NormalizedPaymentEvent {
    const occurredAt = new Date(event.created * 1000);

    switch (event.type) {
      case 'charge.succeeded':
      case 'charge.failed': {
        // Destructure INSIDE each case: narrowing on `event.type` must happen
        // before `event.data.object` can be read as the right object shape.
        const { object } = event.data;
        const succeeded = event.type === 'charge.succeeded';
        return new NormalizedPaymentEvent({
          eventId: `stripe:${event.id}`,
          provider: 'stripe',
          type: succeeded ? 'CHARGE_SUCCEEDED' : 'CHARGE_FAILED',
          // The Stripe PaymentIntent id we store at charge initiation — the
          // reconciliation key back to our PaymentIntent row. (The charge's
          // own ch_... id is provider-side detail we keep only in `raw`.)
          providerRef: object.payment_intent,
          occurredAt,
          amountMinor: object.amount,
          currency: object.currency.toUpperCase(),
          failureReason: succeeded
            ? undefined
            : (object.failure_message ?? 'charge failed'),
          raw: event,
        });
      }
      case 'charge.refunded': {
        const { object } = event.data;
        return new NormalizedPaymentEvent({
          eventId: `stripe:${event.id}`,
          provider: 'stripe',
          type: 'REFUND_COMPLETED',
          providerRef: object.payment_intent,
          occurredAt,
          // Cumulative total refunded on the charge — partial refunds each
          // emit the new cumulative value.
          amountMinor: object.amount_refunded,
          currency: object.currency.toUpperCase(),
          raw: event,
        });
      }
      case 'payout.paid':
      case 'payout.failed': {
        const { object } = event.data;
        const succeeded = event.type === 'payout.paid';
        return new NormalizedPaymentEvent({
          eventId: `stripe:${event.id}`,
          provider: 'stripe',
          type: succeeded ? 'TRANSFER_COMPLETED' : 'TRANSFER_FAILED',
          providerRef: object.id,
          occurredAt,
          amountMinor: object.amount,
          currency: object.currency.toUpperCase(),
          failureReason: succeeded
            ? undefined
            : (object.failure_message ?? 'payout failed'),
          raw: event,
        });
      }
    }
  }
}
