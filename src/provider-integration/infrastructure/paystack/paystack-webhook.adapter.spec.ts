import { createHmac } from 'node:crypto';

import { NormalizedPaymentEvent } from '../../domain/normalized-payment-event';
import {
  InvalidProviderPayloadError,
  InvalidWebhookSignatureError,
  UnrecognizedProviderEventError,
} from '../../application/errors';
import { PaystackWebhookAdapter } from './paystack-webhook.adapter';

/**
 * CONTRACT TESTS against recorded-style fixtures. No live Paystack calls —
 * per non-negotiable #11, provider adapters are tested against fixtures.
 *
 * The fixture bodies below mirror real Paystack webhook payloads (field
 * names and structure per https://paystack.com/docs/payments/webhooks/).
 * HMAC-SHA512 is deterministic, so the signatures computed with the fixture
 * secret ARE the recorded values: any change to how we compute the HMAC, or
 * to the raw-body handling, breaks these tests exactly as a rotated real
 * signature would.
 */
const FIXTURE_SECRET = 'sk_test_fixture_secret_0123456789abcdef';

/** Computes the header value a real Paystack delivery would carry. */
function sign(rawBody: string, secret: string = FIXTURE_SECRET): string {
  return createHmac('sha512', secret)
    .update(Buffer.from(rawBody, 'utf8'))
    .digest('hex');
}

function deliver(rawBody: string, secret: string = FIXTURE_SECRET) {
  const adapter = new PaystackWebhookAdapter(secret);
  return adapter.verifyAndNormalizeWebhook(Buffer.from(rawBody, 'utf8'), {
    'x-paystack-signature': sign(rawBody, secret),
  });
}

const CHARGE_SUCCESS = JSON.stringify({
  event: 'charge.success',
  data: {
    id: 302_991_832,
    reference: 'PSK-CHARGE-REF-1',
    amount: 25_000,
    currency: 'NGN',
    status: 'success',
    paid_at: 1_800_000_000,
    channel: 'card',
  },
});

const TRANSFER_SUCCESS = JSON.stringify({
  event: 'transfer.success',
  data: {
    id: 44_000_001,
    reference: 'PSK-TRANSFER-REF-9',
    amount: 70_000,
    currency: 'NGN',
    reason: 'Payout for order 42',
    created_at: 1_800_000_100,
  },
});

const TRANSFER_FAILED = JSON.stringify({
  event: 'transfer.failed',
  data: {
    id: 44_000_002,
    reference: 'PSK-TRANSFER-REF-10',
    amount: 50_000,
    currency: 'NGN',
    reason: 'Insufficient provider balance',
    created_at: 1_800_000_200,
  },
});

const TRANSFER_REVERSED = JSON.stringify({
  event: 'transfer.reversed',
  data: {
    id: 44_000_003,
    reference: 'PSK-TRANSFER-REF-11',
    amount: 30_000,
    currency: 'NGN',
    created_at: 1_800_000_300,
  },
});

const REFUND_PROCESSED = JSON.stringify({
  event: 'refund.processed',
  data: {
    id: 99_001,
    transaction: { reference: 'PSK-CHARGE-REF-1' },
    amount: 10_000,
    currency: 'NGN',
    created_at: 1_800_000_400,
  },
});

describe('PaystackWebhookAdapter', () => {
  describe('signature verification', () => {
    it('rejects a tampered body (signature computed over different bytes)', async () => {
      const tampered = CHARGE_SUCCESS.replace(
        '25_000'.replace('_', ''),
        '25999',
      );
      const result = await new PaystackWebhookAdapter(
        FIXTURE_SECRET,
      ).verifyAndNormalizeWebhook(Buffer.from(tampered, 'utf8'), {
        'x-paystack-signature': sign(CHARGE_SUCCESS),
      });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toBeInstanceOf(InvalidWebhookSignatureError);
      }
    });

    it('rejects a signature made with the wrong secret', async () => {
      // Signature computed with a DIFFERENT secret than the adapter holds —
      // what an attacker with their own Paystack-like key would produce.
      const adapter = new PaystackWebhookAdapter(FIXTURE_SECRET);
      const result = await adapter.verifyAndNormalizeWebhook(
        Buffer.from(CHARGE_SUCCESS, 'utf8'),
        {
          'x-paystack-signature': sign(
            CHARGE_SUCCESS,
            'sk_test_a_different_secret',
          ),
        },
      );
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toBeInstanceOf(InvalidWebhookSignatureError);
      }
    });

    it('rejects a missing signature header before parsing', async () => {
      const adapter = new PaystackWebhookAdapter(FIXTURE_SECRET);
      const result = await adapter.verifyAndNormalizeWebhook(
        Buffer.from('not even json'),
        {},
      );
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toBeInstanceOf(InvalidWebhookSignatureError);
      }
    });
  });

  describe('event normalization', () => {
    it('maps charge.success to CHARGE_SUCCEEDED with kobo amounts and the charge reference', async () => {
      const result = await deliver(CHARGE_SUCCESS);

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.type).toBe('CHARGE_SUCCEEDED');
      expect(result.value.providerRef).toBe('PSK-CHARGE-REF-1');
      expect(result.value.amountMinor).toBe(25_000);
      expect(result.value.currency).toBe('NGN');
      expect(result.value.occurredAt).toEqual(new Date(1_800_000_000 * 1000));
      // Dedup key is stable across provider retries of the same event.
      expect(result.value.eventId).toBe('paystack:302991832:charge.success');
    });

    it('maps transfer.success to TRANSFER_COMPLETED', async () => {
      const result = await deliver(TRANSFER_SUCCESS);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.type).toBe('TRANSFER_COMPLETED');
      expect(result.value.providerRef).toBe('PSK-TRANSFER-REF-9');
    });

    it('maps transfer.failed and transfer.reversed to TRANSFER_FAILED with reasons', async () => {
      const failed = await deliver(TRANSFER_FAILED);
      expect(failed.ok).toBe(true);
      if (!failed.ok) return;
      expect(failed.value.type).toBe('TRANSFER_FAILED');
      expect(failed.value.failureReason).toBe('Insufficient provider balance');

      const reversed = await deliver(TRANSFER_REVERSED);
      expect(reversed.ok).toBe(true);
      if (!reversed.ok) return;
      expect(reversed.value.type).toBe('TRANSFER_FAILED');
      expect(reversed.value.failureReason).toBe('transfer reversed');
    });

    it('maps refund.processed to REFUND_COMPLETED anchored to the original charge', async () => {
      const result = await deliver(REFUND_PROCESSED);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.type).toBe('REFUND_COMPLETED');
      expect(result.value.providerRef).toBe('PSK-CHARGE-REF-1');
    });

    it.each([
      ['charge.dispute.create'],
      ['refund.failed'],
      ['refund.processing'],
      ['subscription.create'],
      ['invoice.payment_failed'],
    ])('rejects known-but-unmapped event %s', async (event) => {
      const body = JSON.stringify({ event, data: { id: 1 } });
      const result = await deliver(body);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toBeInstanceOf(UnrecognizedProviderEventError);
      }
    });

    it('rejects structurally invalid payloads with valid signatures', async () => {
      const body = JSON.stringify({
        event: 'charge.success',
        data: {
          id: 1,
          reference: 'X',
          amount: 'not-a-number',
          currency: 'NGN',
          paid_at: 1_800_000_000,
        },
      });
      const result = await deliver(body);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toBeInstanceOf(InvalidProviderPayloadError);
      }
    });

    it('produces a NormalizedPaymentEvent that passes the domain constructor', async () => {
      const result = await deliver(CHARGE_SUCCESS);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value).toBeInstanceOf(NormalizedPaymentEvent);
    });
  });
});
