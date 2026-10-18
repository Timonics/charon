/**
 * Injection token for the payment gateway map.
 *
 * The map's *value* is built in the composition root (see
 * AppModule / provider-integration.module.ts) from the
 * `CHRON_PAYMENT_ENABLED_PROVIDERS` environment variable. The
 * payments module looks up gateways through this token, not
 * through a direct import of ProviderIntegrationModule, to
 * avoid circular dependencies.
 */
export const PAYMENT_GATEWAYS = Symbol('PAYMENT_GATEWAYS');

/**
 * Header used by the dev auth guard to inject a Principal. In
 * non-development environments the guard is replaced by
 * CerberusAuthGuard (PR-NN2) and this header is ignored.
 */
export const DEV_PRINCIPAL_HEADER = 'x-dev-principal';
