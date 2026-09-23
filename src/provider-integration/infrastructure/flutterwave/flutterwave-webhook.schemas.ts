import { z } from 'zod';

/**
 * zod schemas for Flutterwave webhook bodies — validated AFTER the verif-hash
 * check, never before (origin first, shape second), mirroring the Paystack
 * adapter's contract.
 *
 * Verified against https://developer.flutterwave.com/docs/webhooks.md (2026-09).
 * Three payload families matter to us; everything else Flutterwave emits
 * (subscriptions, BVNs, bill payments, virtual cards, PSA inflows) is rejected
 * as unmapped by the adapter.
 *
 * Design notes the schemas encode deliberately:
 *
 *  1. Amounts arrive as JSON `number` OR `string` (both appear in the official
 *     docs — wallet funding shows `"amount": "10.70"`). `z.union` accepts
 *     either; the adapter converts to integer minor units via
 *     `Money.fromMajorUnits`, NEVER via JS number math (webhook fees like
 *     `app_fee: 1.4` show Flutterwave is comfortable with floats — we are not).
 *
 *  2. Amounts are in MAJOR units (naira, not kobo) — unlike Paystack's minor
 *     units. The conversion lives in the adapter, one place, next to the
 *     schema that proved the value well-formed.
 *
 *  3. The refund webhook has NO `event` field at all — it is a flat object
 *     with Capitalized field names (`AmountRefunded`, `FlwRef`,
 *     `TransactionId`). That is not a docs typo; it is the actual shape. The
 *     adapter detects it by the ABSENCE of `event`, then this schema proves
 *     the shape before we trust that detection.
 *
 *  4. Statuses are strict enums, not loose strings: `charge.completed` carries
 *     lowercase `successful|failed`, `transfer.completed` carries UPPERCASE
 *     `SUCCESSFUL|FAILED` (yes, inconsistent — verified in the docs samples).
 *     Any other status fails validation and the webhook is rejected loudly,
 *     per the project rule against guessing at ambiguous payloads.
 */

/**
 * Amounts as delivered by Flutterwave: major units, number or numeric string.
 * Conversion to minor units happens in the adapter after schema validation.
 */
const majorAmount = z.union([z.number(), z.string()]);

/** ISO-8601 timestamp string, e.g. "2020-07-06T19:17:04.000Z". */
const isoTimestamp = z.string().refine((s) => !Number.isNaN(Date.parse(s)), {
  message: 'expected an ISO-8601 timestamp',
});

/** Fields every `data` object we consume shares. */
const baseData = {
  /** Flutterwave's own transaction/transfer id — stable across retries. */
  id: z.number().int().positive(),
  currency: z.string().length(3),
};

export const flutterwaveChargeCompletedSchema = z.object({
  event: z.literal('charge.completed'),
  data: z.object({
    ...baseData,
    /** OUR reference from charge initiation — the reconciliation key back
     *  to PaymentIntent (the provider-side equivalent is `flw_ref`). */
    tx_ref: z.string().min(1),
    /** Intended amount in major units. */
    amount: majorAmount,
    /**
     * Amount actually charged in major units. Present on successful charges,
     * ABSENT on failed ones (verified in the docs samples) — the adapter
     * falls back to `amount` when this is missing.
     */
    charged_amount: majorAmount.optional(),
    status: z.enum(['successful', 'failed']),
    /** Provider's explanation on failures — audit-only failure reason. */
    processor_response: z.string().optional(),
    created_at: isoTimestamp,
  }),
});

export const flutterwaveTransferCompletedSchema = z.object({
  event: z.literal('transfer.completed'),
  data: z.object({
    ...baseData,
    /** Merchant-supplied transfer reference — the reconciliation key. */
    reference: z.string().min(1),
    amount: majorAmount,
    status: z.enum(['SUCCESSFUL', 'FAILED']),
    /** Flutterwave's failure detail on failed transfers. */
    complete_message: z.string().optional(),
    created_at: isoTimestamp,
  }),
});

/**
 * The refund webhook: no `event` field, Capitalized keys (exactly as the docs
 * show). `id` is the refund record id; `TransactionId` is the original
 * Flutterwave transaction it refunds — our anchor back to the charge.
 */
export const flutterwaveRefundSchema = z.object({
  id: z.number().int().positive(),
  AmountRefunded: majorAmount,
  status: z.literal('completed'),
  FlwRef: z.string().min(1),
  TransactionId: z.number().int().positive(),
  createdAt: isoTimestamp,
});

export type FlutterwaveChargeCompleted = z.infer<
  typeof flutterwaveChargeCompletedSchema
>;
export type FlutterwaveTransferCompleted = z.infer<
  typeof flutterwaveTransferCompletedSchema
>;
export type FlutterwaveRefund = z.infer<typeof flutterwaveRefundSchema>;
