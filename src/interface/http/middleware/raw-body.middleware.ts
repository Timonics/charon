/**
 * Type augmentation for `req.rawBody`.
 *
 * `main.ts` registers Express's `bodyParser.json({ verify })`
 * which captures the exact byte stream of the request body in
 * the `verify` callback and attaches it to `req.rawBody`.
 * Webhook controllers read this for HMAC signature
 * verification (the signature is computed over the raw bytes,
 * not the parsed JSON).
 *
 * This file declares the `rawBody` property on Express's
 * `Request` interface so the controllers can read
 * `req.rawBody` with type safety. The runtime capture is
 * configured in main.ts.
 */
import type { Buffer } from 'node:buffer';

declare module 'express-serve-static-core' {
  interface Request {
    /**
     * The exact byte stream of the request body, captured
     * before the default bodyParser parses the JSON. Webhook
     * controllers read this for HMAC signature verification.
     * `undefined` if the request had no body (GET, DELETE,
     * POST with no payload, etc.).
     */
    rawBody?: Buffer;
  }
}
