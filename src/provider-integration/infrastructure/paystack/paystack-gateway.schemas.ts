import { z } from 'zod';

/**
 * zod schemas for the Paystack TRANSACTION API (initialize + verify) —
 * the outbound direction, mirroring the webhook schemas' strictness.
 *
 * Verified against Paystack's API reference
 * (https://paystack.com/docs/api/transaction/, 2026-09 — the site blocks
 * automated fetches, so shapes are corroborated across multiple independent
 * current integrations; flagged for live test-mode confirmation before
 * production reliance).
 *
 * Envelope conventions the schemas encode:
 *
 *  - Paystack wraps every answer in `{ status, message, data }`.
 *    `status: true` means the REQUEST succeeded — never that money moved.
 *    Business failures come back as HTTP 4xx/5xx (or 200 with
 *    `status: false`) and a human message. `message` is typed `unknown`
 *    because Paystack sometimes returns a per-field validation OBJECT there;
 *    adapters stringify it for logs rather than crash on the shape.
 *
 *  - Amounts are integer minor units (kobo) — the same convention as our
 *    Money type, so no conversion happens in this adapter.
 *
 *  - `paid_at` is untyped in the wild: ISO-8601 string in the verify API
 *    versus unix seconds in webhooks. The union accepts both and the
 *    adapter converts.
 */

/** Success envelope for POST /transaction/initialize. */
export const paystackInitializeSuccessSchema = z.object({
  status: z.literal(true),
  data: z.object({
    /** Hosted checkout URL to redirect the customer to. */
    authorization_url: z.string().url(),
    access_code: z.string().min(1),
    /** The reference we supplied — echoed back; adapters assert nothing
     *  here (Paystack returns it verbatim), the value is informational. */
    reference: z.string().min(1),
  }),
});

/** Failure envelope ({ status: false }) shared by all Paystack endpoints. */
export const paystackFailureEnvelopeSchema = z.object({
  status: z.literal(false),
  message: z.unknown(),
});

/** Success envelope for GET /transaction/verify/{reference}. */
export const paystackVerifySuccessSchema = z.object({
  status: z.literal(true),
  data: z.object({
    id: z.number().int().positive(),
    /**
     * 'success' | 'failed' | 'abandoned' | 'pending' | ... — kept a plain
     * string here; the adapter maps success/failed and buckets EVERYTHING
     * else as PENDING (an unrecognized status must never fail a charge —
     * that direction of guess is the dangerous one).
     */
    status: z.string(),
    reference: z.string().min(1),
    amount: z.number().int().positive(),
    currency: z.string().length(3),
    /** ISO string in this API; unix seconds elsewhere — union + convert. */
    paid_at: z.union([z.string(), z.number()]).optional(),
    /** Provider's decline/processing explanation; audit-only text. */
    gateway_response: z.string().optional(),
  }),
});

export type PaystackInitializeSuccess = z.infer<
  typeof paystackInitializeSuccessSchema
>;
export type PaystackFailureEnvelope = z.infer<
  typeof paystackFailureEnvelopeSchema
>;
export type PaystackVerifySuccess = z.infer<typeof paystackVerifySuccessSchema>;
