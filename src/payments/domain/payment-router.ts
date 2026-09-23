import type { Money } from '../../shared/kernel/money';
import type { ProviderName } from '../../shared/kernel/provider-name';
import { err, ok, type Result } from '../../shared/kernel/result';
import { RoutingFailedError } from './errors';
import type { PaymentMethod } from './payment-method';

/**
 * Optional hint about the card's issuing country, derived from the BIN/IIN
 * by the interface layer. Drives origin-based re-ordering of provider
 * candidates: Nigerian-issued cards are cheapest/most reliable on the
 * Nigeria-first providers; international cards route to Stripe.
 *
 * 'unknown' means "no hint was provided" and is the safe default: the
 * currency-based ordering is used as-is.
 */
export type CardOrigin = 'nigeria' | 'international' | 'unknown';

/**
 * Input to the routing decision. Deliberately minimal — routing depends on
 * amount (for currency), method, and card origin ONLY. If you find yourself
 * wanting to route on customer history, risk scores, etc., that is a new
 * domain service, not a new field here.
 */
export interface RoutingDecisionInput {
  readonly amount: Money;
  readonly method: PaymentMethod;
  readonly cardOrigin?: CardOrigin;
}

/**
 * Declares what each provider can actually do: which currencies and which
 * methods. The router will never return a provider that cannot handle the
 * requested combination, no matter what the currency preference list says.
 *
 * IMPORTANT (verify against live provider docs before production):
 *  - Paystack supports NGN charges across card / bank transfer / USSD;
 *    mobile-money support is currency/region specific and historically
 *    limited — confirm current coverage.
 *  - Flutterwave's method coverage varies by country (NGN bank transfer and
 *    USSD are supported; card is broad). Pan-African currencies listed here
 *    (GHS/KES/ZAR) are its historic strengths.
 *  - Stripe is card-only for our use case; bank debits/ACH are out of scope.
 */
export interface ProviderCapabilities {
  readonly provider: ProviderName;
  readonly currencies: readonly string[];
  readonly methods: readonly PaymentMethod[];
}

/**
 * The full routing policy, kept as data so it can be unit-tested against
 * fixtures and (in the future) hot-swapped per environment without code
 * changes. `currencyRouting` expresses *preference order*; capability
 * filtering is always applied on top.
 */
export interface RoutingRules {
  /** Currency code (uppercase ISO 4217) → providers in preference order. */
  readonly currencyRouting: Readonly<Record<string, readonly ProviderName[]>>;
  /** What each provider supports; consulted for every candidate. */
  readonly providerCapabilities: readonly ProviderCapabilities[];
}

/**
 * Default production policy. Deliberately conservative: Nigeria-first
 * providers lead for NGN, Stripe leads for international cards, Flutterwave
 * is the pan-African fallback.
 */
export const DEFAULT_ROUTING_RULES: RoutingRules = {
  currencyRouting: {
    NGN: ['paystack', 'flutterwave'],
    USD: ['stripe'],
    EUR: ['stripe'],
    GBP: ['stripe'],
    GHS: ['flutterwave'],
    KES: ['flutterwave'],
    ZAR: ['flutterwave'],
  },
  providerCapabilities: [
    {
      provider: 'paystack',
      currencies: ['NGN'],
      methods: ['card', 'bank_transfer', 'ussd', 'mobile_money'],
    },
    {
      provider: 'flutterwave',
      currencies: ['NGN', 'GHS', 'KES', 'ZAR'],
      methods: ['card', 'bank_transfer', 'ussd', 'mobile_money'],
    },
    {
      provider: 'stripe',
      currencies: ['USD', 'EUR', 'GBP'],
      methods: ['card'],
    },
  ],
};

/**
 * Decides which provider handles a payment. Pure function, no I/O, no
 * randomness — same input always yields the same provider, which keeps
 * routing decisions reproducible in audits and tests.
 *
 * Algorithm:
 *  1. Take the preference list for the payment's currency (empty when the
 *     currency is unknown → routing fails loudly, never silently defaults).
 *  2. Re-order for card-origin hints (Nigerian cards prefer Nigeria-first
 *     providers; international cards prefer Stripe) — stable, so hints only
 *     re-rank, never drop, candidates.
 *  3. Return the first candidate whose declared capabilities cover both the
 *     currency and the method.
 *  4. If nothing qualifies, fail with {@link RoutingFailedError}. There is
 *     intentionally no fallback-to-arbitrary-provider behavior: an
 *     unsupported combination is a client/configuration error, not something
 *     to guess at (see anti-pattern: silent fallback on ambiguity).
 */
export function routePayment(
  input: RoutingDecisionInput,
  rules: RoutingRules = DEFAULT_ROUTING_RULES,
): Result<ProviderName, RoutingFailedError> {
  const candidates = rules.currencyRouting[input.amount.currency] ?? [];
  if (candidates.length === 0) {
    return err(
      new RoutingFailedError(
        `no provider preference configured for currency ${input.amount.currency}`,
      ),
    );
  }

  const ordered = applyCardOriginHint(candidates, input);

  const capabilitiesByProvider = new Map(
    rules.providerCapabilities.map((c) => [c.provider, c]),
  );

  for (const candidate of ordered) {
    const capabilities = capabilitiesByProvider.get(candidate);
    if (
      capabilities &&
      capabilities.currencies.includes(input.amount.currency) &&
      capabilities.methods.includes(input.method)
    ) {
      return ok(candidate);
    }
  }

  return err(
    new RoutingFailedError(
      `no candidate provider supports ${input.amount.currency} via ${input.method} ` +
        `(candidates considered: ${ordered.join(', ') || 'none'})`,
    ),
  );
}

/**
 * Stable re-ordering of candidates based on the card-origin hint. Nigerian
 * cards move Nigeria-first providers to the front (Paystack, then
 * Flutterwave); international cards move Stripe to the front. Candidates not
 * mentioned in the hint keep their relative order after the preferred ones.
 */
function applyCardOriginHint(
  candidates: readonly ProviderName[],
  input: RoutingDecisionInput,
): readonly ProviderName[] {
  if (input.method !== 'card') {
    return candidates;
  }

  const preferred: readonly ProviderName[] | undefined =
    input.cardOrigin === 'nigeria'
      ? ['paystack', 'flutterwave']
      : input.cardOrigin === 'international'
        ? ['stripe']
        : undefined;

  if (!preferred) {
    return candidates;
  }

  const front = preferred.filter((p) => candidates.includes(p));
  const rest = candidates.filter((p) => !front.includes(p));
  return [...front, ...rest];
}
