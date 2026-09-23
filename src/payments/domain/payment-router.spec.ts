import { Money } from '../../shared/kernel/money';
import type { ProviderName } from '../../shared/kernel/provider-name';
import { RoutingFailedError } from './errors';
import type { PaymentMethod } from './payment-method';
import {
  DEFAULT_ROUTING_RULES,
  routePayment,
  type CardOrigin,
  type RoutingDecisionInput,
  type RoutingRules,
} from './payment-router';

function decision(
  amountMinor: number,
  currency: string,
  method: PaymentMethod,
  cardOrigin?: CardOrigin,
): RoutingDecisionInput {
  return { amount: Money.of(amountMinor, currency), method, cardOrigin };
}

/** Custom rules fixture that strips a capability so we can exercise fallback. */
function rulesWithout(
  provider: ProviderName,
  drop: { currencies?: string[]; methods?: PaymentMethod[] },
): RoutingRules {
  return {
    ...DEFAULT_ROUTING_RULES,
    providerCapabilities: DEFAULT_ROUTING_RULES.providerCapabilities.map(
      (c) => {
        if (c.provider !== provider) return c;
        return {
          ...c,
          currencies: c.currencies.filter(
            (cur) => !drop.currencies?.includes(cur),
          ),
          methods: c.methods.filter((m) => !drop.methods?.includes(m)),
        };
      },
    ),
  };
}

describe('routePayment with default rules', () => {
  it.each([
    ['NGN', 'card', undefined, 'paystack'],
    ['NGN', 'bank_transfer', undefined, 'paystack'],
    ['NGN', 'ussd', undefined, 'paystack'],
    ['USD', 'card', undefined, 'stripe'],
    ['EUR', 'card', undefined, 'stripe'],
    ['GBP', 'card', undefined, 'stripe'],
    ['GHS', 'card', undefined, 'flutterwave'],
    ['KES', 'mobile_money', undefined, 'flutterwave'],
    ['ZAR', 'card', undefined, 'flutterwave'],
  ] as const)(
    'routes %s via %s (origin %s) to %s',
    (currency, method, cardOrigin, expected) => {
      const result = routePayment(
        decision(5_000, currency, method, cardOrigin),
      );
      expect(result).toEqual({ ok: true, value: expected });
    },
  );

  it('fails loudly for an unconfigured currency instead of guessing', () => {
    const result = routePayment(decision(5_000, 'JPY', 'card'));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBeInstanceOf(RoutingFailedError);
      expect(result.error.reason).toContain('JPY');
    }
  });

  it('fails loudly when no candidate supports the method', () => {
    const result = routePayment(decision(5_000, 'USD', 'ussd'));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.reason).toContain('ussd');
    }
  });
});

describe('routePayment fallback and card-origin behavior', () => {
  it('falls back to the next preferred provider when the first lacks capability', () => {
    // Paystack temporarily cannot do NGN bank transfers → Flutterwave takes it.
    const rules = rulesWithout('paystack', { methods: ['bank_transfer'] });
    const result = routePayment(decision(5_000, 'NGN', 'bank_transfer'), rules);
    expect(result).toEqual({ ok: true, value: 'flutterwave' });
  });

  it('prefers Nigeria-first providers for Nigerian-issued cards', () => {
    const result = routePayment(decision(5_000, 'NGN', 'card', 'nigeria'));
    expect(result).toEqual({ ok: true, value: 'paystack' });
  });

  it('keeps routing to a capable provider when the hinted provider cannot do the currency', () => {
    // International card, NGN charge: Stripe is hinted first but cannot do
    // NGN, so the router must land on Paystack rather than fail or guess.
    const result = routePayment(
      decision(5_000, 'NGN', 'card', 'international'),
    );
    expect(result).toEqual({ ok: true, value: 'paystack' });
  });

  it('card-origin hints do not affect non-card methods', () => {
    const withHint = routePayment(
      decision(5_000, 'NGN', 'bank_transfer', 'international'),
    );
    const withoutHint = routePayment(decision(5_000, 'NGN', 'bank_transfer'));
    expect(withHint).toEqual(withoutHint);
  });
});
