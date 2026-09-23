import { z } from 'zod';

/**
 * zod schemas for Stripe webhook event envelopes — validated AFTER
 * Stripe-Signature verification, never before (origin first, shape second),
 * mirroring the Paystack and Flutterwave adapters' contract.
 *
 * Signature scheme verified against the reference implementation in
 * stripe-node (src/Webhooks.ts) and
 * https://docs.stripe.com/webhooks/signature (2026-09):
 *
 *  - Every webhook is one EVENT ENVELOPE: `{ id, object: 'event', type,
 *    created, data: { object } }`. `id` (evt_...) is unique per logical event
 *    and STABLE across Stripe's retries — unlike Paystack and Flutterwave,
 *    which force us to compose a dedup key from payload fields, Stripe hands
 *    us a first-class event id, so our dedup key is simply `stripe:{id}`.
 *  - `created` is unix SECONDS at the event level — one timestamp per event,
 *    so the adapter uses it uniformly rather than hunting object-specific
 *    timestamp fields.
 *  - Amounts are ALREADY integer minor units (cents) — Stripe's convention —
 *    so unlike the Flutterwave adapter there is NO major→minor conversion
 *    here. The schema enforces integer amounts directly.
 *  - Currency codes arrive LOWERCASE (Stripe convention); the adapter
 *    uppercases to match our internal convention.
 *
 * Why `discriminatedUnion` on `type`: the shape of `data.object` depends
 * entirely on the event type, and zod's discriminated union makes an
 * unmapped-or-mistyped event fail schema validation loudly instead of
 * producing a half-populated event. Event types we deliberately consume:
 *
 *  - `charge.succeeded`  → CHARGE_SUCCEEDED
 *  - `charge.failed`     → CHARGE_FAILED
 *  - `charge.refunded`   → REFUND_COMPLETED
 *  - `payout.paid`       → TRANSFER_COMPLETED
 *  - `payout.failed`     → TRANSFER_FAILED
 *
 * Everything else Stripe emits (`payment_intent.*`, `charge.dispute.*`,
 * `payout.updated`, `customer.*`, ...) is rejected as unmapped by the
 * adapter. NOTE the transfer vocabulary difference: Stripe has NO
 * `transfer.paid` event — Connect transfers do not emit settlement events;
 * outbound-money settlement over Stripe surfaces as PAYOUT events. Flagged
 * for ratification in the adapter doc comment.
 */

/** Unix timestamp in seconds — Stripe's `created` and `arrival_date` style. */
const unixSeconds = z.number().int().positive();

/**
 * The Charge object fields we consume. We require `payment_intent` to be a
 * non-empty string: this service will always charge through the
 * PaymentIntent API, so a charge with a null `payment_intent` is not ours
 * (legacy Charges/Source API) and must fail loudly rather than reconcile
 * against nothing.
 */
const chargeObject = z.object({
  id: z.string().min(1),
  payment_intent: z.string().min(1),
  /** Integer minor units (cents) — Stripe's convention, no conversion. */
  amount: z.number().int().positive(),
  currency: z.string().length(3),
  /** Human-readable decline explanation on failed charges. */
  failure_message: z.string().nullable().optional(),
  /** Total amount refunded so far — present and meaningful on charge.refunded. */
  amount_refunded: z.number().int().nonnegative().optional(),
});

/** The Payout object fields we consume (payout.paid / payout.failed). */
const payoutObject = z.object({
  id: z.string().min(1),
  amount: z.number().int().positive(),
  currency: z.string().length(3),
  status: z.enum(['paid', 'failed', 'pending', 'canceled']),
  failure_message: z.string().nullable().optional(),
});

/** Fields every Stripe event envelope shares. */
const envelopeBase = {
  /** evt_... — unique per logical event, stable across retries (our dedup key). */
  id: z.string().min(1),
  object: z.literal('event'),
  /** Unix seconds — when Stripe generated the event. */
  created: unixSeconds,
};

export const stripeWebhookEventSchema = z.discriminatedUnion('type', [
  z.object({
    ...envelopeBase,
    type: z.literal('charge.succeeded'),
    data: z.object({ object: chargeObject }),
  }),
  z.object({
    ...envelopeBase,
    type: z.literal('charge.failed'),
    data: z.object({ object: chargeObject }),
  }),
  z.object({
    ...envelopeBase,
    type: z.literal('charge.refunded'),
    data: z.object({ object: chargeObject }),
  }),
  z.object({
    ...envelopeBase,
    type: z.literal('payout.paid'),
    data: z.object({ object: payoutObject }),
  }),
  z.object({
    ...envelopeBase,
    type: z.literal('payout.failed'),
    data: z.object({ object: payoutObject }),
  }),
]);

export type StripeWebhookEvent = z.infer<typeof stripeWebhookEventSchema>;
