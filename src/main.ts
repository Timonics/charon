/**
 * Charon — HTTP entry point.
 *
 * This is the file `yarn start:dev` and `yarn start:prod` ultimately
 * boot. It wires the AppModule, the raw-body middleware (so webhook
 * signature verification can run on the exact byte stream), and the
 * bind address (loopback in production, 0.0.0.0 in the smoke step).
 *
 * Listen address rules (per the production-grade checklist):
 *
 *   - Production: HOST=127.0.0.1 (loopback). Charon is meant to be
 *     fronted by a reverse proxy / load balancer; it should never
 *     be exposed to the public internet directly. Default.
 *   - Smoke / Container: HOST=0.0.0.0 so the container can be
 *     reached by the smoke step. Set CHRON_ENV=smoke to opt in.
 *
 * Raw body rules:
 *
 *   - The webhook endpoints (`/webhooks/:provider`) need the exact
 *     byte stream of the request body for HMAC signature
 *     verification. The default bodyParser in Express parses the
 *     body as JSON before our handler runs, which destroys the
 *     exact bytes (whitespace, key order, escape sequences).
 *   - The RawBodyMiddleware re-collects the raw bytes alongside
 *     the parsed body and attaches them to `req.rawBody`. The
 *     webhook handler reads `req.rawBody` for signature
 *     verification, and falls back to the parsed body for
 *     downstream type narrowing.
 *   - The middleware is applied to the entire app via
 *     `app.use(rawBodyMiddleware)` — the cost is small (one extra
 *     `Buffer.concat` per non-webhook request) and the simplicity
 *     is worth it.
 */
import { Logger, ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { AppModule } from './app.module';
import { RawBodyMiddleware } from './interface/http/middleware/raw-body.middleware';

async function bootstrap(): Promise<void> {
  const logger = new Logger('Bootstrap');
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    bufferLogs: true,
  });

  // Raw-body capture for webhook signature verification. Must run
  // BEFORE the Nest bodyParser so the bytes are collected in their
  // pre-parse form.
  app.use(new RawBodyMiddleware().use);

  // ValidationPipe on the inbound DTO surface. Strips unknown
  // fields, rejects extra fields with `forbidNonWhitelisted`,
  // coerces primitives, and converts the request body to the
  // DTO class via `transform`.
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
      transformOptions: { enableImplicitConversion: true },
    }),
  );

  // Bind address (loopback in production, 0.0.0.0 in smoke).
  const isSmoke = process.env.CHRON_ENV === 'smoke';
  const host = isSmoke ? '0.0.0.0' : (process.env.HOST ?? '127.0.0.1');
  const port = Number.parseInt(process.env.PORT ?? '3000', 10);

  await app.listen(port, host);

  logger.log(
    `Charon listening on http://${host}:${port} ` +
      `(env=${isSmoke ? 'smoke' : (process.env.NODE_ENV ?? 'development')})`,
  );
}

void bootstrap();
