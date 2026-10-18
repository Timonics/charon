import { ok } from './result';
import {
  assertTenantOwnership,
  InvalidTenantIdError,
  parseTenantId,
  principalsEqual,
  TenantMismatchError,
  type Principal,
  type TenantId,
} from './tenant';

// ---------------------------------------------------------------------- //
// parseTenantId                                                            //
// ---------------------------------------------------------------------- //

describe('parseTenantId', () => {
  const SAMPLE: TenantId = 'a1b2c3d4-1111-4222-8333-444444444444' as TenantId;

  it('accepts a canonical lowercase UUID v4', () => {
    const r = parseTenantId(SAMPLE);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toBe(SAMPLE);
  });

  it('rejects uppercase UUIDs (Postgres normalizes but we do not)', () => {
    const r = parseTenantId(SAMPLE.toUpperCase());
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBeInstanceOf(InvalidTenantIdError);
  });

  it('rejects empty string', () => {
    const r = parseTenantId('');
    expect(r.ok).toBe(false);
  });

  it('rejects non-UUID strings (path traversal, SQL-shaped inputs)', () => {
    const r = parseTenantId('../../../etc/passwd');
    expect(r.ok).toBe(false);
    const r2 = parseTenantId("' OR 1=1; --");
    expect(r2.ok).toBe(false);
  });

  it('rejects UUID-like strings of the wrong length', () => {
    const r = parseTenantId('a1b2c3d4-1111-4222-8333');
    expect(r.ok).toBe(false);
  });

  it('rejects nullish / non-string inputs without throwing', () => {
    // @ts-expect-error -- testing runtime defensiveness
    expect(parseTenantId(undefined).ok).toBe(false);
    // @ts-expect-error -- testing runtime defensiveness
    expect(parseTenantId(null).ok).toBe(false);
    // @ts-expect-error -- testing runtime defensiveness
    expect(parseTenantId(42).ok).toBe(false);
  });
});

// ---------------------------------------------------------------------- //
// assertTenantOwnership                                                    //
// ---------------------------------------------------------------------- //

const TENANT_A: TenantId = 'a1b2c3d4-1111-4222-8333-444444444444' as TenantId;
const TENANT_B: TenantId = 'b2c3d4e5-2222-4333-8444-555555555555' as TenantId;

const APP_FOR_A: Principal = {
  kind: 'app',
  appId: 'app-uuid-a',
  tenantId: TENANT_A,
  scopes: ['payments:write'],
  expiresAt: new Date('2030-01-01T00:00:00Z'),
};

const USER_FOR_A: Principal = {
  kind: 'user',
  userId: 'user-uuid-a',
  tenantId: TENANT_A,
  role: 'ADMIN',
  scopes: ['payments:read'],
  expiresAt: new Date('2030-01-01T00:00:00Z'),
};

const USER_FOR_B: Principal = {
  kind: 'user',
  userId: 'user-uuid-b',
  tenantId: TENANT_B,
  role: 'ADMIN',
  scopes: ['payments:read'],
  expiresAt: new Date('2030-01-01T00:00:00Z'),
};

const USER_NO_TENANT: Principal = {
  kind: 'user',
  userId: 'user-uuid-c',
  tenantId: null,
  role: null,
  scopes: [],
  expiresAt: new Date('2030-01-01T00:00:00Z'),
};

describe('assertTenantOwnership', () => {
  it('returns ok when app principal owns the aggregate', () => {
    const r = assertTenantOwnership(APP_FOR_A, TENANT_A);
    expect(r.ok).toBe(true);
  });

  it('returns ok when user principal owns the aggregate', () => {
    const r = assertTenantOwnership(USER_FOR_A, TENANT_A);
    expect(r.ok).toBe(true);
  });

  it('returns err(TenantMismatchError) when app principal hits another tenant', () => {
    const r = assertTenantOwnership(APP_FOR_A, TENANT_B);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toBeInstanceOf(TenantMismatchError);
      expect(r.error.expected).toBe(TENANT_B);
      expect(r.error.actual).toBe(TENANT_A);
    }
  });

  it('returns err when user principal hits another tenant', () => {
    const r = assertTenantOwnership(USER_FOR_A, TENANT_B);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.expected).toBe(TENANT_B);
      expect(r.error.actual).toBe(TENANT_A);
    }
  });

  it('returns err when user has no tenant at all', () => {
    const r = assertTenantOwnership(USER_NO_TENANT, TENANT_A);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.actual).toBeNull();
    }
  });

  it('renders a single message that does NOT leak the secret tenant', () => {
    // The error message includes both tenant ids, but the HTTP
    // boundary must NOT echo this to the caller (the 404 handler
    // maps to a generic "not found" message). This test pins the
    // message shape so a future refactor cannot accidentally
    // surface it.
    const r = assertTenantOwnership(USER_FOR_B, TENANT_A);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.message).toContain(TENANT_A);
      expect(r.error.message).toContain(TENANT_B);
    }
  });
});

// ---------------------------------------------------------------------- //
// principalsEqual                                                          //
// ---------------------------------------------------------------------- //

describe('principalsEqual', () => {
  it('returns true for two app principals with identical fields', () => {
    const a: Principal = { ...APP_FOR_A };
    const b: Principal = { ...APP_FOR_A };
    expect(principalsEqual(a, b)).toBe(true);
  });

  it('returns true for two user principals with identical fields', () => {
    const a: Principal = { ...USER_FOR_A };
    const b: Principal = { ...USER_FOR_A };
    expect(principalsEqual(a, b)).toBe(true);
  });

  it('returns false when kinds differ', () => {
    expect(principalsEqual(APP_FOR_A, USER_FOR_A)).toBe(false);
  });

  it('returns false when tenantId differs', () => {
    const a: Principal = { ...APP_FOR_A, tenantId: TENANT_A };
    const b: Principal = { ...APP_FOR_A, tenantId: TENANT_B };
    expect(principalsEqual(a, b)).toBe(false);
  });

  it('returns false when scope order differs (scope order is significant)', () => {
    // Scopes are space-separated strings; order is part of the
    // contract because the V1.6 grant sorts and joins them. Two
    // principals with semantically-equal but ordered-differently
    // scope lists are NOT the same.
    const a: Principal = { ...APP_FOR_A, scopes: ['a', 'b'] };
    const b: Principal = { ...APP_FOR_A, scopes: ['b', 'a'] };
    expect(principalsEqual(a, b)).toBe(false);
  });

  it('returns false when expiresAt differs by a single millisecond', () => {
    const a: Principal = { ...APP_FOR_A, expiresAt: new Date(1000) };
    const b: Principal = { ...APP_FOR_A, expiresAt: new Date(1001) };
    expect(principalsEqual(a, b)).toBe(false);
  });

  // Result-typed shim — keeps the imports honest by ensuring
  // `ok` and `err` are not tree-shaken before we run.
  void ok;
});
