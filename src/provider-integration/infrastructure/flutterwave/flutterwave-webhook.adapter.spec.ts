import { NormalizedPaymentEvent } from '../../domain/normalized-payment-event';
import {
  InvalidProviderPayloadError,
  InvalidWebhookSignatureError,
  UnrecognizedProviderEventError,
} from '../../application/errors';
import { FlutterwaveWebhookAdapter } from './flutterwave-webhook.adapter';

/**
 * CONTRACT TESTS against recorded-style fixtures. No live Flutterwave calls —
 * per non-negotiable #11, provider adapters are tested against fixtures.
 *
 * The fixture bodies below mirror the official docs samples from
 * https://developer.flutterwave.com/docs/webhooks.md (field names, casing,
 * number-vs-string amounts, status casing). Flutterwave's verification scheme
 * sends the dashboard secret hash VERBATIM in the verif-hash header — the
 * header value IS the secret — so fixture delivery is deterministic by
 * construction: the recorded value and the computed value are the same bytes.
 */
const FIXTURE_SECRET_HASH = 'flw_fixture_secret_hash_0123456789abcdef';

/** Delivers a webhook the way Flutterwave would: verif-hash = the secret hash. */
function deliver(rawBody: string) {
  const adapter = new FlutterwaveWebhookAdapter(FIXTURE_SECRET_HASH);
  return adapter.verifyAndNormalizeWebhook(Buffer.from(rawBody, 'utf8'), {
    'verif-hash': FIXTURE_SECRET_HASH,
  });
}

/** Docs sample: successful card charge. Amounts in MAJOR units (naira). */
const CHARGE_COMPLETED_SUCCESSFUL = JSON.stringify({
  event: 'charge.completed',
  data: {
    id: 285_959_875,
    tx_ref: 'FLW-CHARGE-REF-1',
    flw_ref: 'PeterEkene/FLW270177170',
    amount: 100,
    currency: 'NGN',
    charged_amount: 100,
    processor_response: 'Approved by Financial Institution',
    status: 'successful',
    payment_type: 'card',
    created_at: '2020-07-06T19:17:04.000Z',
  },
});

/** `charged_amount` differs from `amount` — the actually-charged value wins. */
const CHARGE_COMPLETED_FEE_INCLUSIVE = JSON.stringify({
  event: 'charge.completed',
  data: {
    id: 285_959_876,
    tx_ref: 'FLW-CHARGE-REF-2',
    flw_ref: 'FLW270177171',
    amount: 100,
    currency: 'NGN',
    charged_amount: 104,
    status: 'successful',
    created_at: '2020-07-06T19:18:04.000Z',
  },
});

/** Amount as a numeric STRING — both JSON shapes appear in the official docs. */
const CHARGE_COMPLETED_STRING_AMOUNT = JSON.stringify({
  event: 'charge.completed',
  data: {
    id: 285_959_877,
    tx_ref: 'FLW-CHARGE-REF-3',
    flw_ref: 'FLW270177172',
    amount: '10.70',
    currency: 'USD',
    charged_amount: '10.70',
    status: 'successful',
    created_at: '2020-07-06T19:19:04.000Z',
  },
});

/** Docs sample shape: failed charge carries `amount` but NO `charged_amount`. */
const CHARGE_COMPLETED_FAILED = JSON.stringify({
  event: 'charge.completed',
  data: {
    id: 408_136_545,
    tx_ref: 'FLW-CHARGE-REF-4',
    flw_ref: 'NETFLIX/SM31570678271',
    amount: 100_000,
    currency: 'NGN',
    processor_response: 'invalid token supplied',
    status: 'failed',
    created_at: '2021-04-16T14:52:37.000Z',
  },
});

/** Docs sample: successful transfer. Note UPPERCASE status. */
const TRANSFER_COMPLETED_SUCCESSFUL = JSON.stringify({
  event: 'transfer.completed',
  'event.type': 'Transfer',
  data: {
    id: 33_286,
    account_number: '0690000033',
    amount: 30_020,
    currency: 'NGN',
    fee: 26.875,
    status: 'SUCCESSFUL',
    reference: 'FLW-TRANSFER-REF-9',
    complete_message: 'Successful',
    created_at: '2020-04-14T16:39:17.000Z',
  },
});

/** Docs sample shape: failed transfer, failure detail in `complete_message`. */
const TRANSFER_COMPLETED_FAILED = JSON.stringify({
  event: 'transfer.completed',
  'event.type': 'Transfer',
  data: {
    id: 2_207_648,
    amount: 50_000,
    currency: 'NGN',
    fee: 53.75,
    status: 'FAILED',
    reference: 'FLW-TRANSFER-REF-10',
    complete_message:
      'DISBURSE FAILED: You can only spend NGN 1000000.00 at once',
    created_at: '2020-07-06T21:49:02.000Z',
  },
});

/**
 * The refund webhook is a DIFFERENT shape: no `event` field, Capitalized keys.
 * Mirrors the docs sample.
 */
const REFUND_COMPLETED = JSON.stringify({
  id: 99_025,
  AmountRefunded: 100,
  status: 'completed',
  FlwRef: '4687213286',
  TransactionId: 9_231_836,
  createdAt: '2026-01-30T08:35:45.000Z',
});

describe('FlutterwaveWebhookAdapter', () => {
  describe('signature verification', () => {
    it('rejects a missing verif-hash header before parsing', async () => {
      const adapter = new FlutterwaveWebhookAdapter(FIXTURE_SECRET_HASH);
      const result = await adapter.verifyAndNormalizeWebhook(
        Buffer.from('not even json', 'utf8'),
        {},
      );
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toBeInstanceOf(InvalidWebhookSignatureError);
      }
    });

    it('rejects a verif-hash that does not match the configured secret', async () => {
      // The attacker-with-their-own-hash analog: the header carries a hash
      // that is well-formed but is NOT the one this adapter was built with.
      // Note the header still carries the FIXTURE hash — only the adapter's
      // configured secret differs.
      const adapter = new FlutterwaveWebhookAdapter(
        'a_different_configured_secret',
      );
      const result = await adapter.verifyAndNormalizeWebhook(
        Buffer.from(CHARGE_COMPLETED_SUCCESSFUL, 'utf8'),
        { 'verif-hash': FIXTURE_SECRET_HASH },
      );
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toBeInstanceOf(InvalidWebhookSignatureError);
      }
    });
  });

  describe('event normalization', () => {
    it('maps charge.completed+successful to CHARGE_SUCCEEDED, converting major units to kobo', async () => {
      const result = await deliver(CHARGE_COMPLETED_SUCCESSFUL);

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.type).toBe('CHARGE_SUCCEEDED');
      // Reconciliation key is OUR reference, like the Paystack adapter uses.
      expect(result.value.providerRef).toBe('FLW-CHARGE-REF-1');
      expect(result.value.amountMinor).toBe(10_000); // ₦100 major → 10000 kobo
      expect(result.value.currency).toBe('NGN');
      expect(result.value.occurredAt).toEqual(
        new Date('2020-07-06T19:17:04.000Z'),
      );
      // Dedup key is stable across retries but distinct across status changes.
      expect(result.value.eventId).toBe(
        'flutterwave:285959875:charge.completed:successful',
      );
    });

    it('prefers charged_amount over amount when both are present', async () => {
      const result = await deliver(CHARGE_COMPLETED_FEE_INCLUSIVE);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.amountMinor).toBe(10_400); // 104 major, not 100
    });

    it('accepts string amounts and fractional major units (decimal conversion)', async () => {
      const result = await deliver(CHARGE_COMPLETED_STRING_AMOUNT);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.amountMinor).toBe(1_070); // "10.70" USD → 1070 cents
      expect(result.value.currency).toBe('USD');
    });

    it('maps charge.completed+failed to CHARGE_FAILED with processor_response as reason', async () => {
      const result = await deliver(CHARGE_COMPLETED_FAILED);

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.type).toBe('CHARGE_FAILED');
      // Failed charges carry `amount` only — converted from major units.
      expect(result.value.amountMinor).toBe(10_000_000);
      expect(result.value.failureReason).toBe('invalid token supplied');
      expect(result.value.eventId).toBe(
        'flutterwave:408136545:charge.completed:failed',
      );
    });

    it('maps transfer.completed+SUCCESSFUL to TRANSFER_COMPLETED', async () => {
      const result = await deliver(TRANSFER_COMPLETED_SUCCESSFUL);

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.type).toBe('TRANSFER_COMPLETED');
      expect(result.value.providerRef).toBe('FLW-TRANSFER-REF-9');
      expect(result.value.amountMinor).toBe(3_002_000); // 30020 major → kobo
      expect(result.value.eventId).toBe(
        'flutterwave:33286:transfer.completed:SUCCESSFUL',
      );
    });

    it('maps transfer.completed+FAILED to TRANSFER_FAILED with complete_message as reason', async () => {
      const result = await deliver(TRANSFER_COMPLETED_FAILED);

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.type).toBe('TRANSFER_FAILED');
      expect(result.value.failureReason).toBe(
        'DISBURSE FAILED: You can only spend NGN 1000000.00 at once',
      );
    });

    it('maps the event-less refund shape to REFUND_COMPLETED anchored to the original transaction', async () => {
      const result = await deliver(REFUND_COMPLETED);

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.type).toBe('REFUND_COMPLETED');
      expect(result.value.providerRef).toBe('9231836'); // TransactionId
      expect(result.value.eventId).toBe('flutterwave:refund:99025');
      // The documented refund shape has no currency — no amount is normalized.
      expect(result.value.amountMinor).toBeUndefined();
    });

    it.each([
      ['subscription.cancelled'],
      ['bvn.completed'],
      ['singlebillpayment.status'],
    ])('rejects known-but-unmapped event %s', async (event) => {
      const body = JSON.stringify({ event, data: { id: 1 } });
      const result = await deliver(body);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toBeInstanceOf(UnrecognizedProviderEventError);
      }
    });

    it('rejects a no-event payload that is not the refund shape (virtual card debit)', async () => {
      // Virtual card debits ALSO use Capitalized keys and no `event` field —
      // proof the schema, not the casing, is what stands between us and a
      // misclassified payload.
      const virtualCardDebit = JSON.stringify({
        TransactionId: '9998d447-9159-4591-9661-aa7f1458d91b',
        MerchantName: 'Flutterwave',
        Status: 'Successful',
        Amount: 0.2075,
        Type: 'Debit',
      });
      const result = await deliver(virtualCardDebit);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toBeInstanceOf(InvalidProviderPayloadError);
      }
    });

    it('rejects structurally invalid payloads with valid verif-hash', async () => {
      const body = JSON.stringify({
        event: 'charge.completed',
        data: {
          id: 1,
          tx_ref: 'X',
          amount: 100,
          currency: 'NGN',
          status: 'pending', // not successful|failed — must fail loudly
          created_at: '2020-07-06T19:17:04.000Z',
        },
      });
      const result = await deliver(body);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toBeInstanceOf(InvalidProviderPayloadError);
      }
    });

    it('rejects an unconvertible amount as a payload error, not a thrown exception', async () => {
      const body = JSON.stringify({
        event: 'charge.completed',
        data: {
          id: 1,
          tx_ref: 'X',
          amount: -5, // schema-valid JSON number, domain-invalid money
          currency: 'NGN',
          status: 'successful',
          created_at: '2020-07-06T19:17:04.000Z',
        },
      });
      const result = await deliver(body);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toBeInstanceOf(InvalidProviderPayloadError);
      }
    });

    it('produces a NormalizedPaymentEvent that passes the domain constructor', async () => {
      const result = await deliver(CHARGE_COMPLETED_SUCCESSFUL);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value).toBeInstanceOf(NormalizedPaymentEvent);
    });
  });
});
