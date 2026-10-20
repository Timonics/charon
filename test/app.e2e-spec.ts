/**
 * E2E specs for the public HTTP surface.
 *
 * Boots the full Nest application against a real Postgres
 * test database, then drives the routes with supertest. The
 * composition root is the same one the production server
 * uses — only the env is different.
 *
 * What this catches that unit specs do not:
 *   - Module wiring (forgotten exports, missing DI providers)
 *   - Middleware ordering (raw body capture vs bodyParser)
 *   - ValidationPipe configuration (whitelist, transform)
 *   - DTO translation bugs (field name drift, type coercions)
 *   - Auth boundary integration (NoAuthGuard header parsing)
 *   - HTTP error mapping (DomainError → status code)
 *
 * Run with: yarn test:e2e (uses test/jest-e2e.json).
 */
import 'reflect-metadata';
import { createHmac } from 'node:crypto';
import { json } from 'express';
import { ValidationPipe } from '@nestjs/common';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { Server } from 'node:http';
import request from 'supertest';

import { AppModule } from '../src/app.module';
import {
  applyE2eMigrations,
  closeE2ePool,
  truncateE2eTables,
} from './e2e-setup';

const CHRON_PAYSTACK_SECRET_KEY = 'sk_test_e2e_secret_for_hmac_only';
const TEST_TENANT_UUID = 'a1b2c3d4-1111-4222-8333-444444444444';

/**
 * Mirror of the production `main.ts` configuration: the bodyParser
 * (with the raw-body-capture `verify` hook) and the global
 * ValidationPipe. Without these, the e2e suite is testing a
 * different request pipeline than production.
 */
function applyProductionPipes(app: INestApplication): void {
  app.use(
    json({
      limit: '1mb',
      verify: (req, _res, buf) => {
        if (buf && buf.length > 0) {
          (req as unknown as { rawBody?: Buffer }).rawBody = buf;
        }
      },
    }),
  );
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
      transformOptions: { enableImplicitConversion: true },
    }),
  );
}

function principalHeader(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    kind: 'app',
    appId: 'app-e2e-test',
    tenantId: TEST_TENANT_UUID,
    scopes: ['payments:write'],
    expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    ...overrides,
  });
}

describe('Health (e2e)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    process.env.CHRON_PAYSTACK_SECRET_KEY = CHRON_PAYSTACK_SECRET_KEY;
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleRef.createNestApplication();
    applyProductionPipes(app);
    await app.init();
  });

  afterAll(async () => {
    await app?.close();
    await closeE2ePool();
  });

  it('GET /healthz returns 200 + status:ok', async () => {
    interface HealthBody {
      status: 'ok';
      uptimeSeconds: number;
      version: string;
    }
    const res = await request(app.getHttpServer() as Server)
      .get('/healthz')
      .expect(200);
    const body = res.body as HealthBody;
    expect(body.status).toBe('ok');
    expect(typeof body.uptimeSeconds).toBe('number');
    expect(body.version).toBe('0.0.1');
  });
});

describe('PaymentsController (e2e)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    process.env.CHRON_PAYSTACK_SECRET_KEY = CHRON_PAYSTACK_SECRET_KEY;
    applyE2eMigrations();
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleRef.createNestApplication();
    applyProductionPipes(app);
    await app.init();
  });

  beforeEach(async () => {
    await truncateE2eTables();
  });

  afterAll(async () => {
    await app?.close();
    await closeE2ePool();
  });

  it('POST /payments without auth header → 401', async () => {
    await request(app.getHttpServer() as Server)
      .post('/payments')
      .send({})
      .expect(401);
  });

  it('POST /payments with bad idempotencyKey format → 400', async () => {
    await request(app.getHttpServer() as Server)
      .post('/payments')
      .set('X-Dev-Principal', principalHeader())
      .send({
        amountMinor: 100000,
        currency: 'NGN',
        method: 'card',
        idempotencyKey: 'short', // fails Length(16, 128)
      })
      .expect(400);
  });

  it('POST /payments with unknown payment method → 400', async () => {
    await request(app.getHttpServer() as Server)
      .post('/payments')
      .set('X-Dev-Principal', principalHeader())
      .send({
        amountMinor: 100000,
        currency: 'NGN',
        method: 'crypto', // not in the closed set
        idempotencyKey: 'idem_e2e_test_aaaa_002',
      })
      .expect(400);
  });

  it('POST /payments with extra field → 400 (forbidNonWhitelisted)', async () => {
    await request(app.getHttpServer() as Server)
      .post('/payments')
      .set('X-Dev-Principal', principalHeader())
      .send({
        amountMinor: 100000,
        currency: 'NGN',
        method: 'card',
        idempotencyKey: 'idem_e2e_test_aaaa_003',
        unknownField: 'should be rejected',
      })
      .expect(400);
  });
});

describe('WebhooksController (e2e)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    process.env.CHRON_PAYSTACK_SECRET_KEY = CHRON_PAYSTACK_SECRET_KEY;
    applyE2eMigrations();
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleRef.createNestApplication();
    applyProductionPipes(app);
    await app.init();
  });

  beforeEach(async () => {
    await truncateE2eTables();
  });

  afterAll(async () => {
    await app?.close();
  });

  it('POST /webhooks/paystack with no body → 400 (no raw body)', async () => {
    await request(app.getHttpServer() as Server)
      .post('/webhooks/paystack')
      .expect(400);
  });

  it('POST /webhooks/paystack with bad signature → 401', async () => {
    const body = {
      event: 'charge.success',
      data: { id: 1, reference: 'r', amount: 1, currency: 'NGN', paid_at: 0 },
    };
    await request(app.getHttpServer() as Server)
      .post('/webhooks/paystack')
      .set('Content-Type', 'application/json')
      .set('x-paystack-signature', 'deadbeef')
      .send(body)
      .expect(401);
  });

  it('POST /webhooks/paystack with valid signature but bad payload → 400', async () => {
    // The signature is computed correctly so we get past the
    // signature check; the payload is then rejected by the
    // adapter's zod validation.
    const body = {
      event: 'charge.success',
      data: {/* missing required fields */},
    };
    const rawBody = JSON.stringify(body);
    const sig = createHmac('sha512', CHRON_PAYSTACK_SECRET_KEY)
      .update(rawBody)
      .digest('hex');
    await request(app.getHttpServer() as Server)
      .post('/webhooks/paystack')
      .set('Content-Type', 'application/json')
      .set('x-paystack-signature', sig)
      .set('Content-Length', String(Buffer.byteLength(rawBody)))
      .send(rawBody)
      .expect(400);
  });
});
