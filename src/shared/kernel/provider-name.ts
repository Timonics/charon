import { DomainError } from './domain-error';
import { err, ok, type Result } from './result';

/**
 * The closed set of payment providers this service orchestrates.
 *
 * This lives in the shared kernel (not inside any single bounded context)
 * because several contexts need to name a provider without depending on each
 * other:
 *  - `Payments`     — the router picks one as the charge destination.
 *  - `Escrow`       — a hold records which provider's subaccount/split primitive
 *                     holds the funds.
 *  - `ProviderIntegration` — adapters declare which one they implement.
 *
 * It is a closed union on purpose: adding a provider is a deliberate code
 * change (new adapter, new routing rules, new webhook normalizer), never a
 * runtime configuration value. Provider names coming from outside the process
 * (env vars, webhook payloads, database rows) MUST pass through
 * {@link parseProviderName} before they may be used as a `ProviderName`.
 */
export const PROVIDER_NAMES = ['stripe', 'paystack', 'flutterwave'] as const;

export type ProviderName = (typeof PROVIDER_NAMES)[number];

export class UnknownProviderError extends DomainError {
  readonly code = 'UNKNOWN_PROVIDER';

  constructor(raw: string) {
    super(
      `Unknown payment provider: "${raw}". Expected one of: ${PROVIDER_NAMES.join(', ')}`,
    );
  }
}

/**
 * Validates an untrusted string into the {@link ProviderName} union.
 *
 * Typical call sites: reading provider configuration from environment
 * variables, or deserializing persisted rows that store a provider code.
 */
export function parseProviderName(
  raw: string,
): Result<ProviderName, UnknownProviderError> {
  const normalized = raw.trim().toLowerCase();
  if ((PROVIDER_NAMES as readonly string[]).includes(normalized)) {
    return ok(normalized as ProviderName);
  }
  return err(new UnknownProviderError(raw));
}
