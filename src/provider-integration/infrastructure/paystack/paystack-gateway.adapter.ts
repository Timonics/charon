import type { ZodType } from 'zod';

import type {
  HttpClient,
  HttpRequestInput,
} from '../../../shared/infrastructure/http-client';
import type { ProviderName } from '../../../shared/kernel/provider-name';
import { err, ok, type Result } from '../../../shared/kernel/result';
import type { DomainError } from '../../../shared/kernel/domain-error';
import {
  type ChargeVerification,
  type ChargeVerificationStatus,
  type InitializedCharge,
  type InitializeChargeInput,
  type PaymentGatewayPort,
} from '../../application/ports/payment-gateway.port';
import { ProviderApiError } from '../../application/errors';
import {
  paystackFailureEnvelopeSchema,
  paystackInitializeSuccessSchema,
  paystackVerifySuccessSchema,
  type PaystackFailureEnvelope,
  type PaystackInitializeSuccess,
  type PaystackVerifySuccess,
} from './paystack-gateway.schemas';

/**
 * Paystack outbound gateway adapter — implements
 * {@link PaymentGatewayPort} for the charge half of the
 * provider integration.
 *
 * Two endpoints, both over HTTPS with bearer auth:
 *
 *   POST  /transaction/initialize
 *     Body: { reference, amount, currency, email, callback_url?,
 *             metadata? }
 *     → 200 { status: true, data: { authorization_url, access_code,
 *                                reference } } when the provider
 *       accepts the request and mints a hosted checkout URL.
 *     → 200 { status: false, message } when the provider refuses
 *       a request it parsed cleanly.
 *     → 4xx/5xx for transport / authentication errors.
 *
 *   GET   /transaction/verify/{reference}
 *     → 200 { status: true, data: { id, status, reference, amount,
 *                                currency, paid_at?, gateway_response? } }
 *
 *   See https://paystack.com/docs/api/transaction/ for the
 *   authoritative reference. The zod schemas in
 *   `paystack-gateway.schemas.ts` are the source of truth in
 *   code.
 *
 * Reconciliation contract
 * -----------------------
 * Per the {@link PaymentGatewayPort} doc comment, this adapter
 * returns `providerReference = reference` (the same string the
 * caller passed in). The webhook adapter reads the same `reference`
 * out of webhook payloads. If the two ever disagree, the
 * `HandlePaymentWebhookUseCase` Defense 2 (unknown reference)
 * rejects the event.
 *
 * Operational notes
 * -----------------
 * - HTTP transport is injected via the {@link HttpClient} port.
 *   In production this is `FetchHttpClient`; in tests it is an
 *   in-memory fake. The adapter never sees `fetch` directly.
 * - The Paystack secret key is a CONSTRUCTOR argument. The
 *   composition root reads it from the environment
 *   (`PAYSTACK_SECRET_KEY`); the adapter never touches
 *   process.env itself. The same secret is shared with the
 *   webhook adapter for signature verification.
 * - `baseUrl` defaults to `https://api.paystack.co/` so tests can
 *   point at a recorded cassette URL without touching the
 *   adapter code.
 */
export class PaystackGatewayAdapter implements PaymentGatewayPort {
  readonly provider: ProviderName = 'paystack';

  private static readonly DEFAULT_BASE_URL = 'https://api.paystack.co/';

  /**
   * Paystack's default timeout is generous. We cap at 30s so a
   * hung Paystack doesn't keep an InitiatePaymentUseCase
   * connection open past the user's patience. The HttpClient
   * port's `AbortController` honors this.
   */
  private static readonly DEFAULT_TIMEOUT_MS = 30_000;

  constructor(
    private readonly http: HttpClient,
    private readonly secretKey: string,
    private readonly baseUrl: string = PaystackGatewayAdapter.DEFAULT_BASE_URL,
  ) {
    if (!secretKey || secretKey.trim().length === 0) {
      throw new Error('PaystackGatewayAdapter: secretKey is required');
    }
  }

  async initializeCharge(
    input: InitializeChargeInput,
  ): Promise<Result<InitializedCharge, DomainError>> {
    // Paystack's initialize API expects form-encoded body fields
    // plus a JSON-ified `metadata` map. We do the JSON.stringify
    // of metadata here so the wire shape matches Paystack's
    // reference implementations exactly.
    const body: Record<string, string> = {
      reference: input.reference,
      amount: String(input.amountMinor),
      currency: input.currency,
      email: input.customerEmail,
    };
    if (input.callbackUrl) body.callback_url = input.callbackUrl;
    if (input.metadata) body.metadata = JSON.stringify(input.metadata);

    const request: HttpRequestInput = {
      method: 'POST',
      url: `${this.baseUrl}transaction/initialize`,
      headers: {
        Authorization: `Bearer ${this.secretKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
      timeoutMs: PaystackGatewayAdapter.DEFAULT_TIMEOUT_MS,
    };

    return this.executeRequest(
      request,
      paystackInitializeSuccessSchema,
      (parsed) => this.toInitializedCharge(parsed, input),
    );
  }

  async verifyCharge(
    providerReference: string,
  ): Promise<Result<ChargeVerification, DomainError>> {
    if (!providerReference || providerReference.trim().length === 0) {
      return err(
        new ProviderApiError(
          this.provider,
          'verify',
          'providerReference must be a non-empty string',
        ),
      );
    }

    const request: HttpRequestInput = {
      method: 'GET',
      url: `${this.baseUrl}transaction/verify/${encodeURIComponent(providerReference)}`,
      headers: {
        Authorization: `Bearer ${this.secretKey}`,
      },
      timeoutMs: PaystackGatewayAdapter.DEFAULT_TIMEOUT_MS,
    };

    return this.executeRequest(request, paystackVerifySuccessSchema, (parsed) =>
      this.toChargeVerification(parsed),
    );
  }

  /**
   * Generic POST/GET helper. Three layers of failure handling:
   *
   *   1. Transport failure (no response) — already typed by
   *      HttpClient.send returning `err(HttpTransportError)`. We
   *      pass it through unchanged; it carries enough context
   *      (URL + reason) for the caller to log.
   *   2. HTTP non-2xx — we wrap the status + body into
   *      `ProviderApiError`. The body is sanitized (we never
   *      include the Authorization header) and a payload parse
   *      failure doesn't leak a stack trace.
   *   3. 2xx with a failure envelope ({ status: false }) — the
   *      schema-driven `parseResponse` returns the parsed
   *      failure envelope, which we map to `ProviderApiError`
   *      with the message Paystack gave us.
   *
   * On 2xx + success envelope, we call `mapper` to convert the
   * zod-parsed payload into the port-shaped return value.
   */
  private async executeRequest<TParsed, TOut>(
    request: HttpRequestInput,
    successSchema: ZodType<TParsed>,
    mapper: (parsed: TParsed) => TOut,
  ): Promise<Result<TOut, DomainError>> {
    const response = await this.http.send(request);
    if (!response.ok) {
      // Layer 1: transport failure. Already typed.
      return err(response.error);
    }
    const { status, bodyText } = response.value;
    if (status < 200 || status >= 300) {
      // Layer 2: HTTP non-2xx. Sanitize the body — we never include
      // the request (which carries the Authorization header).
      const safeBody =
        bodyText.length > 200 ? bodyText.slice(0, 200) + '…' : bodyText;
      return err(
        new ProviderApiError(
          this.provider,
          `${request.method} ${request.url}`,
          `HTTP ${status}: ${safeBody || '<empty body>'}`,
        ),
      );
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(bodyText);
    } catch {
      return err(
        new ProviderApiError(
          this.provider,
          `${request.method} ${request.url}`,
          'response body is not valid JSON',
        ),
      );
    }
    const success = successSchema.safeParse(parsed);
    if (success.success) {
      return ok(mapper(success.data));
    }
    // Layer 3: 2xx with failure envelope. The schemas share
    // `{ status: false, message }` for all Paystack endpoints,
    // so a single failure parser handles every call site.
    const failure = paystackFailureEnvelopeSchema.safeParse(parsed);
    if (failure.success) {
      return err(
        new ProviderApiError(
          this.provider,
          `${request.method} ${request.url}`,
          this.stringifyMessage(failure.data),
        ),
      );
    }
    // Neither shape matched. The response is something Paystack
    // does not document — treat as a transport-shape error.
    return err(
      new ProviderApiError(
        this.provider,
        `${request.method} ${request.url}`,
        'response shape did not match success or failure envelope',
      ),
    );
  }

  /**
   * Map Paystack's initialize success body to the port's
   * {@link InitializedCharge}. The `providerReference` is the
   * same `reference` we sent in — Paystack echoes it back, and
   * our reconciliation contract depends on that echo.
   */
  private toInitializedCharge(
    parsed: PaystackInitializeSuccess,
    input: InitializeChargeInput,
  ): InitializedCharge {
    return {
      providerReference: parsed.data.reference,
      checkoutUrl: parsed.data.authorization_url,
      raw: {
        accessCode: parsed.data.access_code,
        sentReference: input.reference,
        sentAmountMinor: input.amountMinor,
        sentCurrency: input.currency,
      },
    };
  }

  /**
   * Map Paystack's verify success body to the port's
   * {@link ChargeVerification}. Per the port doc comment, the
   * status string is bucketed: "success" → SUCCEEDED,
   * "failed" → FAILED, anything else → PENDING.
   *
   * `paid_at` arrives in two shapes across Paystack endpoints:
   * ISO-8601 string in the verify API, unix seconds in webhooks.
   * The schema accepts both; here we normalize to a Date.
   */
  private toChargeVerification(
    parsed: PaystackVerifySuccess,
  ): ChargeVerification {
    const status = this.mapStatus(parsed.data.status);
    const paidAt = this.parsePaidAt(parsed.data.paid_at);
    return {
      status,
      providerReference: parsed.data.reference,
      amountMinor: parsed.data.amount,
      currency: parsed.data.currency,
      paidAt,
      failureReason: parsed.data.gateway_response,
      raw: {
        providerId: parsed.data.id,
        paystackStatus: parsed.data.status,
      },
    };
  }

  private mapStatus(paystackStatus: string): ChargeVerificationStatus {
    switch (paystackStatus) {
      case 'success':
        return 'SUCCEEDED';
      case 'failed':
        return 'FAILED';
      default:
        // 'abandoned', 'pending', or anything Paystack adds in
        // the future. The port contract says: any non-terminal
        // state is PENDING. An unrecognized status must NEVER
        // become a FAILED (the dangerous direction of guess).
        return 'PENDING';
    }
  }

  private parsePaidAt(value: string | number | undefined): Date | undefined {
    if (value === undefined) return undefined;
    if (typeof value === 'number') {
      // Paystack webhooks use unix seconds; the verify API uses
      // ISO strings, but tolerate the numeric shape too.
      return new Date(value * 1000);
    }
    // ISO-8601 string. new Date parses RFC 3339 cleanly; if the
    // provider ever sends a non-ISO shape, the resulting Date
    // is `Invalid Date` (NaN epoch) which is what the caller
    // would see anyway, so we let it pass through.
    const d = new Date(value);
    if (Number.isNaN(d.getTime())) return undefined;
    return d;
  }

  /**
   * Paystack's `message` field is typed `unknown` because the
   * API sometimes returns a per-field validation object there
   * (e.g. `{ email: ["invalid"] }`). For logs and error messages
   * we need a string. JSON.stringify handles both shapes; the
   * fallback catches `null`/`undefined`/circular cases.
   */
  private stringifyMessage(envelope: PaystackFailureEnvelope): string {
    if (envelope.message === null || envelope.message === undefined) {
      return '(no message)';
    }
    try {
      return JSON.stringify(envelope.message);
    } catch {
      return '(unserialisable message)';
    }
  }
}

// The spec imports HttpTransportError directly from
// '../../../shared/infrastructure/http-client' to construct
// transport-failure fixtures. We do not re-export it here
// because every importer can reach the shared/ tree directly
// — the re-export was unnecessary coupling.
