import { DomainError } from '../kernel/domain-error';
import { err, ok, type Result } from '../kernel/result';

/**
 * Minimal outbound HTTP abstraction. Provider gateway adapters (and any
 * future infrastructure that calls third parties) depend on this interface,
 * never on `fetch` directly — tests substitute an in-memory fake and replay
 * recorded fixtures without network access (non-negotiable #11), and the
 * composition root supplies the fetch-based implementation.
 *
 * Deliberately tiny: providers used here need only JSON POST/GET with custom
 * headers. Anything richer (redirects, cookies, streaming) is out of scope
 * until a real need exists.
 */

/** A single outbound request. `body` is the exact wire payload (already-encoded). */
export interface HttpRequestInput {
  readonly method: 'GET' | 'POST';
  readonly url: string;
  readonly headers?: Record<string, string>;
  readonly body?: string;
  /** Per-request ceiling; defaults are the implementation's business. */
  readonly timeoutMs?: number;
}

/**
 * The response as received — status code plus the raw body TEXT. Adapters
 * parse/validate with zod themselves: response-shape discipline is the
 * adapter's contract, not the transport's.
 */
export interface HttpResponseSnapshot {
  readonly status: number;
  readonly bodyText: string;
}

/**
 * The request never got a response: DNS failure, connection refused, TLS
 * error, or the timeout fired. DISTINCT from an HTTP error status — an
 * unreachable provider is a retry-later condition, while a 4xx/5xx with a
 * body is a provider answer that may carry a structured error envelope.
 */
export class HttpTransportError extends DomainError {
  readonly code = 'HTTP_TRANSPORT_ERROR';

  constructor(
    readonly url: string,
    reason: string,
  ) {
    super(`HTTP request to ${url} failed: ${reason}`);
  }
}

export interface HttpClient {
  /**
   * Never throws for non-2xx statuses (that is a {@link HttpResponseSnapshot},
   * and how to interpret it is the caller's business). Only transport-level
   * failure produces an error Result.
   */
  send(
    input: HttpRequestInput,
  ): Promise<Result<HttpResponseSnapshot, HttpTransportError>>;
}

const DEFAULT_TIMEOUT_MS = 30_000;

/**
 * Production {@link HttpClient} built on the global `fetch` (Node 18+).
 * Timeouts via AbortController — a provider that hangs must fail fast and
 * cleanly, not park an adapter until the caller gives up.
 */
export class FetchHttpClient implements HttpClient {
  async send(
    input: HttpRequestInput,
  ): Promise<Result<HttpResponseSnapshot, HttpTransportError>> {
    const timeoutMs = input.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(input.url, {
        method: input.method,
        headers: input.headers,
        body: input.body,
        signal: controller.signal,
      });
      return ok({
        status: response.status,
        bodyText: await response.text(),
      });
    } catch (error) {
      // AbortError (our timeout) and system-level failures (DNS, TLS,
      // connection refused) all land here — the message distinguishes them
      // well enough for logs.
      const reason =
        error instanceof Error && error.name === 'AbortError'
          ? `timed out after ${timeoutMs}ms`
          : error instanceof Error
            ? error.message
            : String(error);
      return err(new HttpTransportError(input.url, reason));
    } finally {
      clearTimeout(timer);
    }
  }
}
