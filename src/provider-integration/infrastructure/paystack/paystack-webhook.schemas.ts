import { z } from 'zod';

/**
 * zod schemas for Paystack webhook bodies — validated AFTER signature
 * verification, never before (origin first, shape second). The schemas are
 * deliberately strict: only the fields we consume are required, but those
 * must have exactly the expected types. A provider payload change produces
 * a validation failure here, not a silently half-populated event.
 */

const baseData = {
  /** Paystack transaction id (stable across retries — part of our dedup key). */
  id: z.number().int().positive(),
  /** Amount in kobo: integer minor units, matching our Money convention. */
  amount: z.number().int().positive(),
  currency: z.string().length(3),
};

/** Unix timestamp fields Paystack sends as seconds since epoch. */
const unixSeconds = z.number().int().positive();

export const paystackChargeSuccessSchema = z.object({
  event: z.literal('charge.success'),
  data: z.object({
    ...baseData,
    /** Our charge reference — the reconciliation key back to PaymentIntent. */
    reference: z.string().min(1),
    status: z.string(),
    paid_at: unixSeconds,
  }),
});

export const paystackTransferSchema = z.object({
  event: z.enum(['transfer.success', 'transfer.failed', 'transfer.reversed']),
  data: z.object({
    ...baseData,
    /** Transfer reference (distinct from the charge reference space). */
    reference: z.string().min(1),
    reason: z.string().optional(),
    created_at: unixSeconds,
  }),
});

export const paystackRefundProcessedSchema = z.object({
  event: z.literal('refund.processed'),
  data: z.object({
    ...baseData,
    /** The refund is anchored to the original transaction. */
    transaction: z.object({ reference: z.string().min(1) }),
    created_at: unixSeconds,
  }),
});

export type PaystackChargeSuccess = z.infer<typeof paystackChargeSuccessSchema>;
export type PaystackTransfer = z.infer<typeof paystackTransferSchema>;
export type PaystackRefundProcessed = z.infer<
  typeof paystackRefundProcessedSchema
>;
