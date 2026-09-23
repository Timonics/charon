import Decimal from 'decimal.js';
import {
  add as dineroAdd,
  allocate as dineroAllocate,
  compare,
  dinero,
  equal as dineroEqual,
  greaterThan as dineroGreaterThan,
  haveSameCurrency,
  isNegative,
  isZero,
  subtract as dineroSubtract,
  toDecimal,
  toSnapshot,
  type Dinero,
  type DineroCurrency,
  type DineroComparisonOperator,
} from 'dinero.js';
import * as isoCurrencies from 'dinero.js/currencies';

import { DomainError } from './domain-error';

export class InvalidMoneyError extends DomainError {
  readonly code = 'INVALID_MONEY';

  constructor(reason: string) {
    super(`Invalid money: ${reason}`);
  }
}

export class UnknownCurrencyError extends DomainError {
  readonly code = 'UNKNOWN_CURRENCY';

  constructor(currencyCode: string) {
    super(`Unsupported currency: ${currencyCode}`);
  }
}

export class CurrencyMismatchError extends DomainError {
  readonly code = 'CURRENCY_MISMATCH';

  constructor(left: string, right: string) {
    super(`Cannot operate on ${left} and ${right} together`);
  }
}

export interface MoneySnapshot {
  /** Integer amount in the currency's minor unit (kobo, cents). */
  readonly amount: number;
  /** Uppercase ISO 4217 code. */
  readonly currency: string;
}

const CURRENCIES = isoCurrencies as Record<string, DineroCurrency<number>>;

function resolveCurrency(currencyCode: string): DineroCurrency<number> {
  const currency = CURRENCIES[currencyCode.trim().toUpperCase()];
  if (!currency) {
    throw new UnknownCurrencyError(currencyCode);
  }
  return currency;
}

/**
 * Immutable monetary value in a single currency.
 *
 * Amounts are always integers in the minor unit (kobo/cents). Construction from
 * fractional major-unit strings is only allowed via {@link Money.fromMajorUnits},
 * which rounds half-up at the boundary — never inside calculations.
 */
export class Money {
  private constructor(private readonly value: Dinero<number>) {}

  static of(amount: number, currencyCode: string): Money {
    if (!Number.isSafeInteger(amount)) {
      throw new InvalidMoneyError(
        `amount must be a safe integer, got ${amount}`,
      );
    }
    if (amount < 0) {
      throw new InvalidMoneyError('amount must not be negative');
    }
    return new Money(
      dinero({ amount, currency: resolveCurrency(currencyCode) }),
    );
  }

  static zero(currencyCode: string): Money {
    return Money.of(0, currencyCode);
  }

  static fromMajorUnits(value: string, currencyCode: string): Money {
    const currency = resolveCurrency(currencyCode);
    let decimal: Decimal;
    try {
      decimal = new Decimal(value);
    } catch {
      throw new InvalidMoneyError(`invalid major-unit amount: ${value}`);
    }
    if (decimal.isNaN() || !decimal.isFinite() || decimal.isNegative()) {
      throw new InvalidMoneyError(`invalid major-unit amount: ${value}`);
    }
    const minor = decimal
      .times(new Decimal(10).pow(currency.exponent))
      .toDecimalPlaces(0, Decimal.ROUND_HALF_UP);
    if (
      !minor.isInt() ||
      !minor.isFinite() ||
      minor.greaterThan(Number.MAX_SAFE_INTEGER)
    ) {
      throw new InvalidMoneyError(
        `amount out of range after conversion: ${value}`,
      );
    }
    return Money.of(minor.toNumber(), currencyCode);
  }

  static fromSnapshot(snapshot: MoneySnapshot): Money {
    return Money.of(snapshot.amount, snapshot.currency);
  }

  static supportedCurrencyCodes(): string[] {
    return Object.keys(CURRENCIES);
  }

  /** Integer amount in minor units (kobo/cents). */
  get amount(): number {
    return toSnapshot(this.value).amount;
  }

  /** Uppercase ISO 4217 code. */
  get currency(): string {
    return toSnapshot(this.value).currency.code;
  }

  add(other: Money): Money {
    return new Money(dineroAdd(this.value, this.sameCurrency(other).value));
  }

  subtract(other: Money): Money {
    const result = dineroSubtract(this.value, this.sameCurrency(other).value);
    if (isNegative(result)) {
      throw new InvalidMoneyError('subtraction result would be negative');
    }
    return new Money(result);
  }

  compare(other: Money): DineroComparisonOperator {
    return compare(this.value, this.sameCurrency(other).value);
  }

  equals(other: Money): boolean {
    return (
      haveSameCurrency([this.value, other.value]) &&
      dineroEqual(this.value, other.value)
    );
  }

  isZero(): boolean {
    return isZero(this.value);
  }

  /**
   * Strict greater-than comparison against another same-currency value.
   * Expressed as a boolean (rather than exposing dinero's numeric
   * comparison operator) so callers can write domain invariants like
   * `if (total.isGreaterThan(limit))` without enum-comparison ceremony.
   */
  isGreaterThan(other: Money): boolean {
    return dineroGreaterThan(this.value, this.sameCurrency(other).value);
  }

  /**
   * Splits this amount across integer ratios (e.g. `[70, 30]`).
   * Remainders are distributed to the earliest ratios, so the results always
   * sum back to the original amount.
   */
  allocate(ratios: readonly number[]): Money[] {
    if (
      ratios.length === 0 ||
      ratios.some((r) => !Number.isInteger(r) || r < 0) ||
      ratios.reduce((sum, r) => sum + r, 0) <= 0
    ) {
      throw new InvalidMoneyError(
        'allocation ratios must be non-negative integers with a positive sum',
      );
    }
    return dineroAllocate(this.value, [...ratios]).map((d) => new Money(d));
  }

  toSnapshot(): MoneySnapshot {
    const { amount, currency } = toSnapshot(this.value);
    return { amount, currency: currency.code };
  }

  /** Major-unit decimal string, e.g. "123.45". For display/serialization only — never parse this back for math. */
  toDecimal(): string {
    return toDecimal(this.value);
  }

  toString(): string {
    return `${this.toDecimal()} ${this.currency}`;
  }

  private sameCurrency(other: Money): Money {
    if (!haveSameCurrency([this.value, other.value])) {
      throw new CurrencyMismatchError(this.currency, other.currency);
    }
    return other;
  }
}
