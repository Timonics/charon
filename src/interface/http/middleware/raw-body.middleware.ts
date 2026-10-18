/**
 * Raw-body capture middleware.
 *
 * Webhook signature verification (Paystack HMAC-SHA512, Stripe
 * `Stripe-Signature` HMAC, Flutterwave `verif-hash` HMAC) needs the
 * exact byte stream of the inbound request — the signature is
 * computed over those bytes by the provider, and any
 * re-serialization (whitespace changes, key reordering, Unicode
 * normalization) would invalidate the signature.
 *
 * NestJS's default bodyParser parses the body as JSON *before* our
 * handler runs, which is too late. The middleware below uses a
 * custom Express middleware that:
 *
 *   1. Subscribes to the `data` event on the raw `IncomingMessage`
 *      and accumulates the bytes into a `Buffer`.
 *   2. Lets the default bodyParser still run afterwards, so the
 *      parsed body is available for non-webhook routes.
 *   3. Attaches the raw buffer to `req.rawBody` (with a typed
 *      augmentation) so the webhook controller can read it.
 *
 * For non-webhook routes the raw body is captured but never used,
 * so the cost is one extra `Buffer.concat` per request — small
 * and worth the simplicity of not branching the middleware at
 * the route level.
 */
import type { NextFunction, Request, Response } from 'express';
import type { IncomingMessage } from 'node:http';

declare module 'express-serve-static-core' {
  interface Request {
    /**
     * The exact byte stream of the request body, captured before
     * the default bodyParser runs. Webhook controllers read this
     * for HMAC signature verification. `undefined` if the request
     * had no body (GET, DELETE, etc.).
     */
    rawBody?: Buffer;
  }
}

export class RawBodyMiddleware {
  use = (req: Request, _res: Response, next: NextFunction): void => {
    const rawChunks: Array<Buffer> = [];
    const incoming = req as Request & { body?: unknown };

    // We subscribe to the raw stream directly. The default
    // bodyParser has not run yet at this point (the order in
    // main.ts is `app.use(rawBodyMiddleware)` BEFORE Nest wires
    // the bodyParser), so the data event is the source of truth.
    const raw = (
      incoming as unknown as { socket?: { parser?: IncomingMessage } }
    ).socket?.parser;
    if (!raw) {
      // No parser (e.g. HTTP/2 or unit-test transport). Skip
      // capture — the request will fall back to the parsed
      // body and the webhook handler will fail loudly with
      // "no raw body" if it ever calls into this path.
      next();
      return;
    }
    raw.on('data', (chunk: Buffer) => {
      rawChunks.push(chunk);
    });
    raw.on('end', () => {
      if (rawChunks.length > 0) {
        incoming.rawBody = Buffer.concat(rawChunks);
      }
      next();
    });
    raw.on('error', (err) => {
      next(err);
    });
  };
}
