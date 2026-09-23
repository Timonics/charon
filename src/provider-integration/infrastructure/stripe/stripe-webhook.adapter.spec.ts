import { createHmac } from 'node:crypto';

import { NormalizedPaymentEvent } from '../../domain/normalized-payment-event';
import {
  InvalidProviderPayloadError,
  InvalidWebhookSignatureError,
  UnrecognizedProviderEventError,
} from '../../application/errors';
import { StripeWebhookAdapter } from './stripe-webhook.adapter';

/**
 * CONTRACT TESTS against recorded-style fixtures. No live Stripe calls —
 * per non-negotiable #11, provider adapters are tested against fixtures.
 *
 * The HMAC scheme is deterministic given (timestamp, body, secret), so the
 * `sign` helper below produces EXACTLY the header bytes a real Stripe
 * delivery would carry — any change to how we compute the HMAC, to the
 * signed-material construction (`{timestamp}.{body}`), or to raw-body
 * handling breaks these tests exactly as a rotated real secret would.
 *
 * Fixture envelopes mirror Stripe's event shape: `{ id, object: 'event',
 * type, created, data: { object } }`, amounts in integer minor units,
 * lowercase currency codes.
 */
const FIXTURE_SECRET = 'whsec_fixture_secret_0123456789abcdef';
const FIXTURE_NOW_MS = 1_800_000_000_000; // fixed clock for tolerance tests
const FIXTURE_TS = Math.floor(FIXTURE_NOW_MS / 1000);

/**
 * Computes the `Stripe-Signature` header value a real Stripe delivery would
 * carry, per stripe-node's generateTestHeaderString: signed material is
 * `{timestamp}.{rawBody}`, HMAC-SHA256 keyed with the whsec_ secret verbatim.
 */
function sign(
  rawBody: string,
  timestamp: number = FIXTURE_TS,
  secret: string = FIXTURE_SECRET,
): string {
  const v1 = createHmac('sha256', secret)
    .update(`${timestamp}.${rawBody}`)
    .digest('hex');
  return `t=${timestamp},v1=${v1}`;
}

/** Delivers a webhook with a valid signature at the fixture's fixed clock. */
function deliver(rawBody: string, header: string = sign(rawBody)) {
  const adapter = new StripeWebhookAdapter(FIXTURE_SECRET, {
    now: () => FIXTURE_NOW_MS,
  });
  return adapter.verifyAndNormalizeWebhook(Buffer.from(rawBody, 'utf8'), {
    'stripe-signature': header,
  });
}

const CHARGE_SUCCEEDED = JSON.stringify({
  id: 'evt_charge_ok_1',
  object: 'event',
  type: 'charge.succeeded',
  created: FIXTURE_TS,
  data: {
    object: {
      id: 'ch_1NqInRLkdIwHu7ixIiS1Tu4v',
      payment_intent: 'pi_3QlzFBLkdIwHu7ix0y1',
      amount: 2_500,
      currency: 'usd',
      amount_refunded: 0,
      failure_message: null,
    },
  },
});

const CHARGE_FAILED = JSON.stringify({
  id: 'evt_charge_fail_1',
  object: 'event',
  type: 'charge.failed',
  created: FIXTURE_TS,
  data: {
    object: {
      id: 'ch_1NqInRLkdIwHu7ixIiS1Tu4v',
      payment_intent: 'pi_3QlzFBLkdIwHu7ix0y1',
      amount: 2_500,
      currency: 'usd',
      failure_message: 'Your card was declined.',
    },
  },
});

const CHARGE_REFUNDED = JSON.stringify({
  id: 'evt_refund_1',
  object: 'event',
  type: 'charge.refunded',
  created: FIXTURE_TS,
  data: {
    object: {
      id: 'ch_1NqInRLkdIwHu7ixIiS1Tu4v',
      payment_intent: 'pi_3QlzFBLkdIwHu7ix0y1',
      amount: 2_500,
      currency: 'usd',
      amount_refunded: 1_000,
    },
  },
});

const PAYOUT_PAID = JSON.stringify({
  id: 'evt_payout_ok_1',
  object: 'event',
  type: 'payout.paid',
  created: FIXTURE_TS,
  data: {
    object: {
      id: 'po_1OaFDbEcg9tTZuTgNYmX0PKB',
      amount: 70_000,
      currency: 'usd',
      status: 'paid',
    },
  },
});

const PAYOUT_FAILED = JSON.stringify({
  id: 'evt_payout_fail_1',
  object: 'event',
  type: 'payout.failed',
  created: FIXTURE_TS,
  data: {
    object: {
      id: 'po_1OaFDbEcg9tTZuTgNYmX0PKB',
      amount: 70_000,
      currency: 'usd',
      status: 'failed',
      failure_message: 'Bank account has been closed.',
    },
  },
});

describe('StripeWebhookAdapter', () => {
  describe('signature verification', () => {
    it('rejects a missing stripe-signature header before parsing', async () => {
      const adapter = new StripeWebhookAdapter(FIXTURE_SECRET);
      const result = await adapter.verifyAndNormalizeWebhook(
        Buffer.from('not even json', 'utf8'),
        {},
      );
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toBeInstanceOf(InvalidWebhookSignatureError);
      }
    });

    it('rejects a signature made with the wrong secret', async () => {
      const adapter = new StripeWebhookAdapter(FIXTURE_SECRET, {
        now: () => FIXTURE_NOW_MS,
      });
      const result = await adapter.verifyAndNormalizeWebhook(
        Buffer.from(CHARGE_SUCCEEDED, 'utf8'),
        {
          'stripe-signature': sign(
            CHARGE_SUCCEEDED,
            FIXTURE_TS,
            'whsec_a_different_secret',
          ),
        },
      );
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toBeInstanceOf(InvalidWebhookSignatureError);
      }
    });

    it('rejects a tampered body (signature computed over different bytes)', async () => {
      const tampered = CHARGE_SUCCEEDED.replace(
        '2_500'.replace('_', ''),
        '2501',
      );
      const result = await deliver(tampered, sign(CHARGE_SUCCEEDED));
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toBeInstanceOf(InvalidWebhookSignatureError);
      }
    });

    it('rejects a stale timestamp outside the tolerance window', async () => {
      const staleTs = FIXTURE_TS - 400; // > 300s old at the fixture clock
      const result = await deliver(
        CHARGE_SUCCEEDED,
        sign(CHARGE_SUCCEEDED, staleTs),
      );
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toBeInstanceOf(InvalidWebhookSignatureError);
        expect(result.error.message).toContain('tolerance');
      }
    });

    it('accepts when any of multiple v1 signatures matches (secret rotation)', async () => {
      // Stripe signs with both old and new secrets during rotation; the
      // header may carry several v1 entries and ANY match verifies.
      const stale = createHmac('sha256', 'whsec_old_rotated_secret')
        .update(`${FIXTURE_TS}.${CHARGE_SUCCEEDED}`)
        .digest('hex');
      const fresh = sign(CHARGE_SUCCEEDED);
      const header = `t=${FIXTURE_TS},v1=${stale},v1=${fresh.split('v1=')[1]}`;
      const result = await deliver(CHARGE_SUCCEEDED, header);
      expect(result.ok).toBe(true);
    });
  });

  describe('event normalization', () => {
    it('maps charge.succeeded to CHARGE_SUCCEEDED keyed by payment_intent', async () => {
      const result = await deliver(CHARGE_SUCCEEDED);

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.type).toBe('CHARGE_SUCCEEDED');
      // Stripe amounts are already integer minor units — no conversion.
      expect(result.value.amountMinor).toBe(2_500);
      expect(result.value.currency).toBe('USD'); // lowercased by Stripe, normalized
      // Reconciliation key is the PaymentIntent id we store at initiation.
      expect(result.value.providerRef).toBe('pi_3QlzFBLkdIwHu7ix0y1');
      expect(result.value.occurredAt).toEqual(new Date(FIXTURE_TS * 1000));
      // Stripe's event id is first-class and retry-stable — no composition.
      expect(result.value.eventId).toBe('stripe:evt_charge_ok_1');
    });

    it('maps charge.failed to CHARGE_FAILED with failure_message as reason', async () => {
      const result = await deliver(CHARGE_FAILED);

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.type).toBe('CHARGE_FAILED');
      expect(result.value.failureReason).toBe('Your card was declined.');
    });

    it('maps charge.refunded to REFUND_COMPLETED with the cumulative refunded amount', async () => {
      const result = await deliver(CHARGE_REFUNDED);

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.type).toBe('REFUND_COMPLETED');
      expect(result.value.providerRef).toBe('pi_3QlzFBLkdIwHu7ix0y1');
      expect(result.value.amountMinor).toBe(1_000); // amount_refunded, not amount
    });

    it('maps payout.paid to TRANSFER_COMPLETED keyed by the payout id', async () => {
      const result = await deliver(PAYOUT_PAID);

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.type).toBe('TRANSFER_COMPLETED');
      expect(result.value.providerRef).toBe('po_1OaFDbEcg9tTZuTgNYmX0PKB');
      expect(result.value.amountMinor).toBe(70_000);
    });

    it('maps payout.failed to TRANSFER_FAILED with failure_message as reason', async () => {
      const result = await deliver(PAYOUT_FAILED);

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.type).toBe('TRANSFER_FAILED');
      expect(result.value.failureReason).toBe('Bank account has been closed.');
    });

    it.each([
      ['payment_intent.succeeded'],
      ['charge.dispute.created'],
      ['payout.updated'],
      ['account.updated'],
    ])('rejects known-but-unmapped event %s', async (type) => {
      const body = JSON.stringify({
        id: 'evt_other_1',
        object: 'event',
        type,
        created: FIXTURE_TS,
        data: { object: {} },
      });
      const result = await deliver(body);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toBeInstanceOf(UnrecognizedProviderEventError);
      }
    });

    it('rejects a mapped event whose payload does not match the schema', async () => {
      // charge.succeeded WITHOUT payment_intent — a charge we could never
      // reconcile. Signature is valid; the schema must still reject it.
      const body = JSON.stringify({
        id: 'evt_charge_bad_1',
        object: 'event',
        type: 'charge.succeeded',
        created: FIXTURE_TS,
        data: { object: { id: 'ch_x', amount: 2_500, currency: 'usd' } },
      });
      const result = await deliver(body);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toBeInstanceOf(InvalidProviderPayloadError);
      }
    });

    it('produces a NormalizedPaymentEvent that passes the domain constructor', async () => {
      const result = await deliver(CHARGE_SUCCEEDED);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value).toBeInstanceOf(NormalizedPaymentEvent);
    });
  });
});
