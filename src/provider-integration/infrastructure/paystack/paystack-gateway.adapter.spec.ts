import { err, ok, type Result } from '../../../shared/kernel/result';
import { HttpTransportError } from '../../../shared/infrastructure/http-client';
import type {
  HttpClient,
  HttpRequestInput,
  HttpResponseSnapshot,
} from '../../../shared/infrastructure/http-client';
import { ProviderApiError } from '../../application/errors';
import { PaystackGatewayAdapter } from './paystack-gateway.adapter';

// --------------------------------------------------------------------- //
// In-memory HttpClient fake                                            //
// --------------------------------------------------------------------- //
//
// This fake records every request the adapter makes and returns a
// scripted response. The scripts are themselves a fixture — they
// mirror real Paystack response shapes so the adapter's parsing
// logic is exercised against realistic data, not a synthetic stub.
//
// Per non-negotiable #11 ("provider adapters are tested against
// recorded fixtures, not against live provider APIs in tests"),
// the spec NEVER hits api.paystack.co. The test runner is offline.
//
// To assert "the adapter sent the right headers / body", the
// fake exposes the last request it received. To assert "the
// adapter returned X for response Y", the test sets up the
// scripted response BEFORE calling the adapter.

interface ScriptedResponse {
  readonly status: number;
  readonly bodyText: string;
}

class FakeHttpClient implements HttpClient {
  /** What the next call to send() will return. */
  private scripted: Result<HttpResponseSnapshot, HttpTransportError>;
  /** Every request the adapter has made, in order. */
  readonly requests: HttpRequestInput[] = [];

  constructor(scripted: Result<HttpResponseSnapshot, HttpTransportError>) {
    this.scripted = scripted;
  }

  setScripted(
    scripted: Result<HttpResponseSnapshot, HttpTransportError>,
  ): void {
    this.scripted = scripted;
  }

  async send(
    input: HttpRequestInput,
  ): Promise<Result<HttpResponseSnapshot, HttpTransportError>> {
    await Promise.resolve();
    this.requests.push(input);
    return this.scripted;
  }
}

// Helper builders for the most common scripted-response shapes.
// Each mirrors a real Paystack response (see the zod schemas in
// paystack-gateway.schemas.ts) so the adapter's parsing logic
// runs against realistic data.
const PAYSTACK_INIT_OK = (
  reference: string,
  authorizationUrl = 'https://checkout.paystack.com/abc123',
): ScriptedResponse => ({
  status: 200,
  bodyText: JSON.stringify({
    status: true,
    data: {
      authorization_url: authorizationUrl,
      access_code: 'access_' + reference,
      reference,
    },
  }),
});

const PAYSTACK_INIT_FAIL = (message: string): ScriptedResponse => ({
  status: 200,
  bodyText: JSON.stringify({ status: false, message }),
});

const PAYSTACK_VERIFY_OK = (
  reference: string,
  status: 'success' | 'failed' | 'abandoned' | 'pending' = 'success',
  amount = 25_000,
  currency = 'NGN',
  paidAt?: string,
  gatewayResponse?: string,
): ScriptedResponse => ({
  status: 200,
  bodyText: JSON.stringify({
    status: true,
    data: {
      id: 12345,
      status,
      reference,
      amount,
      currency,
      paid_at: paidAt,
      gateway_response: gatewayResponse,
    },
  }),
});

const PAYSTACK_VERIFY_FAIL = (message: string): ScriptedResponse => ({
  status: 200,
  bodyText: JSON.stringify({ status: false, message }),
});

const HTTP_500: ScriptedResponse = {
  status: 500,
  bodyText: '{"error": "internal server error"}',
};

const HTTP_INVALID_JSON: ScriptedResponse = {
  status: 200,
  bodyText: '{not valid json',
};

const HTTP_UNRECOGNIZED_SHAPE: ScriptedResponse = {
  status: 200,
  bodyText: JSON.stringify({ totally: 'unknown shape' }),
};

// --------------------------------------------------------------------- //
// Tests                                                                  //
// --------------------------------------------------------------------- //

const SECRET = 'sk_test_abc123';
const TEST_INPUT = {
  reference: 'order-12345',
  amountMinor: 25_000,
  currency: 'NGN',
  customerEmail: 'alice@example.com',
  callbackUrl: 'https://merchant.example.com/return',
  metadata: { invoiceId: 'inv-001' },
};

describe('PaystackGatewayAdapter', () => {
  // ------------------------------------------------------------------ //
  // initializeCharge                                                   //
  // ------------------------------------------------------------------ //
  describe('initializeCharge', () => {
    it('returns a checkout URL + echoes the reference on success', async () => {
      const http = new FakeHttpClient(ok(PAYSTACK_INIT_OK('order-12345')));
      const adapter = new PaystackGatewayAdapter(http, SECRET);

      const result = await adapter.initializeCharge(TEST_INPUT);
      expect(result.ok).toBe(true);
      if (!result.ok) return; // narrow for type
      expect(result.value.providerReference).toBe('order-12345');
      expect(result.value.checkoutUrl).toBe(
        'https://checkout.paystack.com/abc123',
      );
      expect(result.value.clientSecret).toBeUndefined();
      expect(result.value.raw).toMatchObject({
        accessCode: 'access_order-12345',
        sentReference: 'order-12345',
        sentAmountMinor: 25_000,
        sentCurrency: 'NGN',
      });
    });

    it('POSTs to the Paystack initialize endpoint with bearer auth + JSON body', async () => {
      const http = new FakeHttpClient(ok(PAYSTACK_INIT_OK('order-12345')));
      const adapter = new PaystackGatewayAdapter(http, SECRET);

      await adapter.initializeCharge(TEST_INPUT);

      const req = http.requests[0];
      expect(req.method).toBe('POST');
      expect(req.url).toBe('https://api.paystack.co/transaction/initialize');
      expect(req.headers?.['Authorization']).toBe(`Bearer ${SECRET}`);
      expect(req.headers?.['Content-Type']).toBe('application/json');
      const body = JSON.parse(req.body ?? '{}') as Record<string, unknown>;
      expect(body).toEqual({
        reference: 'order-12345',
        amount: '25000',
        currency: 'NGN',
        email: 'alice@example.com',
        callback_url: 'https://merchant.example.com/return',
        // The metadata is JSON-stringified so the wire shape
        // matches Paystack's reference implementations.
        metadata: JSON.stringify({ invoiceId: 'inv-001' }),
      });
    });

    it('omits optional fields when the caller did not provide them', async () => {
      const http = new FakeHttpClient(ok(PAYSTACK_INIT_OK('order-min')));
      const adapter = new PaystackGatewayAdapter(http, SECRET);
      await adapter.initializeCharge({
        reference: 'order-min',
        amountMinor: 100,
        currency: 'NGN',
        customerEmail: 'b@example.com',
      });
      const body = JSON.parse(http.requests[0].body ?? '{}') as Record<
        string,
        unknown
      >;
      expect(body).not.toHaveProperty('callback_url');
      expect(body).not.toHaveProperty('metadata');
    });

    it('returns ProviderApiError when Paystack returns a failure envelope', async () => {
      const http = new FakeHttpClient(
        ok(PAYSTACK_INIT_FAIL('Invalid reference: duplicate')),
      );
      const adapter = new PaystackGatewayAdapter(http, SECRET);

      const result = await adapter.initializeCharge(TEST_INPUT);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error).toBeInstanceOf(ProviderApiError);
      expect(result.error.code).toBe('PROVIDER_API_ERROR');
      expect((result.error as ProviderApiError).provider).toBe('paystack');
      // The stringified message is included so logs have signal.
      expect(result.error.message).toContain('Invalid reference');
    });

    it('returns ProviderApiError on HTTP 500', async () => {
      const http = new FakeHttpClient(ok(HTTP_500));
      const adapter = new PaystackGatewayAdapter(http, SECRET);

      const result = await adapter.initializeCharge(TEST_INPUT);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error).toBeInstanceOf(ProviderApiError);
      expect(result.error.message).toContain('HTTP 500');
    });

    it('returns ProviderApiError when the response body is not JSON', async () => {
      const http = new FakeHttpClient(ok(HTTP_INVALID_JSON));
      const adapter = new PaystackGatewayAdapter(http, SECRET);

      const result = await adapter.initializeCharge(TEST_INPUT);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error).toBeInstanceOf(ProviderApiError);
      expect(result.error.message).toContain('not valid JSON');
    });

    it('returns ProviderApiError when the JSON shape matches neither success nor failure envelope', async () => {
      const http = new FakeHttpClient(ok(HTTP_UNRECOGNIZED_SHAPE));
      const adapter = new PaystackGatewayAdapter(http, SECRET);

      const result = await adapter.initializeCharge(TEST_INPUT);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.message).toContain(
        'did not match success or failure envelope',
      );
    });

    it('returns HttpTransportError when the network call fails', async () => {
      // The HttpClient port returns err(HttpTransportError) for
      // transport-level failure. The adapter must pass it
      // through unchanged — re-wrapping as ProviderApiError
      // would lose the timeout-vs-business-failure distinction.
      const transportErr = new HttpTransportError(
        'https://api.paystack.co/transaction/initialize',
        'timed out after 30000ms',
      );
      const http = new FakeHttpClient(err(transportErr));
      const adapter = new PaystackGatewayAdapter(http, SECRET);

      const result = await adapter.initializeCharge(TEST_INPUT);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error).toBe(transportErr);
    });

    it('stringifies a structured failure.message without crashing', async () => {
      // Paystack sometimes returns a per-field validation object
      // in `message` (e.g. { email: ["invalid"] }). The adapter
      // must serialize that, not throw on a non-string field.
      const http = new FakeHttpClient(
        ok({
          status: 200,
          bodyText: JSON.stringify({
            status: false,
            message: { email: ['is invalid'], amount: ['too low'] },
          }),
        }),
      );
      const adapter = new PaystackGatewayAdapter(http, SECRET);

      const result = await adapter.initializeCharge(TEST_INPUT);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.message).toContain('email');
      expect(result.error.message).toContain('amount');
    });
  });

  // ------------------------------------------------------------------ //
  // verifyCharge                                                       //
  // ------------------------------------------------------------------ //
  describe('verifyCharge', () => {
    it('returns SUCCEEDED + paidAt when the status is "success"', async () => {
      const http = new FakeHttpClient(
        ok(
          PAYSTACK_VERIFY_OK(
            'order-12345',
            'success',
            25_000,
            'NGN',
            '2026-10-17T12:00:00Z',
          ),
        ),
      );
      const adapter = new PaystackGatewayAdapter(http, SECRET);

      const result = await adapter.verifyCharge('order-12345');
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.status).toBe('SUCCEEDED');
      expect(result.value.providerReference).toBe('order-12345');
      expect(result.value.amountMinor).toBe(25_000);
      expect(result.value.currency).toBe('NGN');
      expect(result.value.paidAt?.toISOString()).toBe(
        '2026-10-17T12:00:00.000Z',
      );
    });

    it('returns FAILED + failureReason when the status is "failed"', async () => {
      const http = new FakeHttpClient(
        ok(
          PAYSTACK_VERIFY_OK(
            'order-12345',
            'failed',
            25_000,
            'NGN',
            undefined,
            'Insufficient funds',
          ),
        ),
      );
      const adapter = new PaystackGatewayAdapter(http, SECRET);

      const result = await adapter.verifyCharge('order-12345');
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.status).toBe('FAILED');
      expect(result.value.failureReason).toBe('Insufficient funds');
    });

    it('buckets unrecognized statuses (e.g. "abandoned", "pending") as PENDING', async () => {
      // The dangerous direction of guess is FAILED. An unrecognized
      // status must NEVER become a FAILED — verification
      // corroborates webhooks, and the webhook handler decides
      // settlement. The adapter reports PENDING and leaves the
      // domain layer to wait.
      for (const paystackStatus of ['abandoned', 'pending', 'reversed']) {
        const http = new FakeHttpClient(
          ok(PAYSTACK_VERIFY_OK('order-12345', paystackStatus as 'success')),
        );
        const adapter = new PaystackGatewayAdapter(http, SECRET);
        const result = await adapter.verifyCharge('order-12345');
        expect(result.ok).toBe(true);
        if (!result.ok) continue;
        expect(result.value.status).toBe('PENDING');
      }
    });

    it('accepts unix-seconds paid_at (webhook shape) and converts to Date', async () => {
      // The verify API uses ISO-8601 strings; the webhook
      // payload uses unix seconds. The schema accepts both. This
      // assertion pins the cross-format behavior — without it
      // a future "let's only accept ISO" change would silently
      // break verify-after-webhook flows.
      const unixSeconds = 1731000000; // 2024-11-08T04:00:00Z
      const http = new FakeHttpClient(
        ok({
          status: 200,
          bodyText: JSON.stringify({
            status: true,
            data: {
              id: 1,
              status: 'success',
              reference: 'order-12345',
              amount: 25_000,
              currency: 'NGN',
              paid_at: unixSeconds,
            },
          }),
        }),
      );
      const adapter = new PaystackGatewayAdapter(http, SECRET);

      const result = await adapter.verifyCharge('order-12345');
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.paidAt?.getTime()).toBe(unixSeconds * 1000);
    });

    it('rejects an empty providerReference with a typed ProviderApiError', async () => {
      const http = new FakeHttpClient(ok(PAYSTACK_VERIFY_OK('order-12345')));
      const adapter = new PaystackGatewayAdapter(http, SECRET);
      const result = await adapter.verifyCharge('');
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error).toBeInstanceOf(ProviderApiError);
      // The HTTP client must not be touched on a validation
      // failure — no point spending the round-trip.
      expect(http.requests).toHaveLength(0);
    });

    it('returns ProviderApiError when Paystack returns a failure envelope', async () => {
      const http = new FakeHttpClient(
        ok(PAYSTACK_VERIFY_FAIL('Invalid reference')),
      );
      const adapter = new PaystackGatewayAdapter(http, SECRET);

      const result = await adapter.verifyCharge('order-12345');
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error).toBeInstanceOf(ProviderApiError);
    });

    it('encodes the provider reference in the URL', async () => {
      const http = new FakeHttpClient(ok(PAYSTACK_VERIFY_OK('order/123')));
      const adapter = new PaystackGatewayAdapter(http, SECRET);
      await adapter.verifyCharge('order/123');
      // The slash in the reference MUST be percent-encoded so the
      // path doesn't get treated as a directory. Without this,
      // a reference like "org/123" hits /transaction/verify/org/123
      // which Paystack interprets as a different route.
      expect(http.requests[0].url).toBe(
        'https://api.paystack.co/transaction/verify/order%2F123',
      );
    });

    it('honors a custom baseUrl (test cassette / staging)', async () => {
      // Tests can point the adapter at a recorded cassette URL
      // instead of api.paystack.co. Production uses the default.
      const http = new FakeHttpClient(ok(PAYSTACK_VERIFY_OK('order-12345')));
      const adapter = new PaystackGatewayAdapter(
        http,
        SECRET,
        'https://cassettes.example.com/paystack/',
      );
      await adapter.verifyCharge('order-12345');
      expect(http.requests[0].url).toBe(
        'https://cassettes.example.com/paystack/transaction/verify/order-12345',
      );
    });
  });

  // ------------------------------------------------------------------ //
  // constructor                                                         //
  // ------------------------------------------------------------------ //
  describe('constructor', () => {
    it('rejects an empty secret key', () => {
      const http = new FakeHttpClient(ok(PAYSTACK_VERIFY_OK('x')));
      expect(() => new PaystackGatewayAdapter(http, '')).toThrow();
      expect(() => new PaystackGatewayAdapter(http, '   ')).toThrow();
    });

    it('exposes the provider name "paystack"', () => {
      const http = new FakeHttpClient(ok(PAYSTACK_VERIFY_OK('x')));
      expect(new PaystackGatewayAdapter(http, SECRET).provider).toBe(
        'paystack',
      );
    });
  });
});
