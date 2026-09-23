import {
  CurrencyMismatchError,
  InvalidMoneyError,
  Money,
  UnknownCurrencyError,
} from './money';

describe('Money.of', () => {
  it('creates money from integer minor units', () => {
    const money = Money.of(12_345, 'NGN');
    expect(money.amount).toBe(12_345);
    expect(money.currency).toBe('NGN');
  });

  it('normalizes currency codes to uppercase', () => {
    expect(Money.of(1, 'usd').currency).toBe('USD');
    expect(Money.of(1, ' ngn ').currency).toBe('NGN');
  });

  it.each([[1.5], [-1], [0.1], [Number.MAX_SAFE_INTEGER + 2]])(
    'rejects non-integer or unsafe amount %s',
    (amount) => {
      expect(() => Money.of(amount, 'NGN')).toThrow(InvalidMoneyError);
    },
  );

  it('rejects unknown currencies', () => {
    expect(() => Money.of(1, 'XXX')).toThrow(UnknownCurrencyError);
  });

  it('creates a zero value', () => {
    const zero = Money.zero('USD');
    expect(zero.isZero()).toBe(true);
    expect(zero.toSnapshot()).toEqual({ amount: 0, currency: 'USD' });
  });
});

describe('Money.fromMajorUnits', () => {
  it('converts a decimal string using the currency exponent', () => {
    expect(Money.fromMajorUnits('123.45', 'NGN').toSnapshot()).toEqual({
      amount: 12_345,
      currency: 'NGN',
    });
    expect(Money.fromMajorUnits('0.99', 'USD').toSnapshot()).toEqual({
      amount: 99,
      currency: 'USD',
    });
  });

  it('rounds half-up at the conversion boundary', () => {
    expect(Money.fromMajorUnits('0.005', 'USD').amount).toBe(1);
    expect(Money.fromMajorUnits('0.004', 'USD').amount).toBe(0);
  });

  it.each([['abc'], ['-1.00'], ['Infinity'], ['NaN'], ['1,000.00']])(
    'rejects invalid input %s',
    (value) => {
      expect(() => Money.fromMajorUnits(value, 'NGN')).toThrow(
        InvalidMoneyError,
      );
    },
  );
});

describe('Money arithmetic', () => {
  it('adds same-currency values', () => {
    const total = Money.of(5_000, 'NGN').add(Money.of(2_500, 'NGN'));
    expect(total.toSnapshot()).toEqual({ amount: 7_500, currency: 'NGN' });
  });

  it('subtracts same-currency values', () => {
    const remainder = Money.of(5_000, 'NGN').subtract(Money.of(2_500, 'NGN'));
    expect(remainder.amount).toBe(2_500);
  });

  it('rejects cross-currency operations', () => {
    const ngn = Money.of(1, 'NGN');
    const usd = Money.of(1, 'USD');
    expect(() => ngn.add(usd)).toThrow(CurrencyMismatchError);
    expect(() => ngn.subtract(usd)).toThrow(CurrencyMismatchError);
    expect(() => ngn.compare(usd)).toThrow(CurrencyMismatchError);
  });

  it('rejects subtraction that would go negative', () => {
    expect(() => Money.of(100, 'NGN').subtract(Money.of(101, 'NGN'))).toThrow(
      InvalidMoneyError,
    );
  });

  it('compares and tests equality', () => {
    expect(Money.of(100, 'NGN').compare(Money.of(200, 'NGN'))).toBe(-1);
    expect(Money.of(200, 'NGN').compare(Money.of(100, 'NGN'))).toBe(1);
    expect(Money.of(100, 'NGN').compare(Money.of(100, 'NGN'))).toBe(0);
    expect(Money.of(100, 'NGN').equals(Money.of(100, 'NGN'))).toBe(true);
    expect(Money.of(100, 'NGN').equals(Money.of(101, 'NGN'))).toBe(false);
  });

  it('exposes boolean greater-than for invariant checks', () => {
    expect(Money.of(101, 'NGN').isGreaterThan(Money.of(100, 'NGN'))).toBe(true);
    expect(Money.of(100, 'NGN').isGreaterThan(Money.of(100, 'NGN'))).toBe(
      false,
    );
    expect(Money.of(99, 'NGN').isGreaterThan(Money.of(100, 'NGN'))).toBe(false);
    expect(() => Money.of(1, 'NGN').isGreaterThan(Money.of(1, 'USD'))).toThrow(
      CurrencyMismatchError,
    );
  });
});

describe('Money.allocate', () => {
  it('splits by ratios and the parts sum to the original', () => {
    const parts = Money.of(10_000, 'NGN').allocate([70, 30]);
    expect(parts.map((p) => p.amount)).toEqual([7_000, 3_000]);
  });

  it('distributes remainder to the earliest ratios', () => {
    const parts = Money.of(100, 'NGN').allocate([1, 1, 1]);
    expect(parts.map((p) => p.amount)).toEqual([34, 33, 33]);
  });

  it('returns a single part for a 100% ratio', () => {
    const parts = Money.of(4_999, 'NGN').allocate([1]);
    expect(parts).toHaveLength(1);
    expect(parts[0].amount).toBe(4_999);
  });

  it.each([[[]], [[0, 0]], [[-1, 2]], [[1.5, 1]]])(
    'rejects invalid ratios %j',
    (ratios) => {
      expect(() => Money.of(100, 'NGN').allocate(ratios)).toThrow(
        InvalidMoneyError,
      );
    },
  );
});

describe('Money serialization', () => {
  it('round-trips through snapshots', () => {
    const original = Money.of(99_999, 'GHS');
    const restored = Money.fromSnapshot(original.toSnapshot());
    expect(restored.equals(original)).toBe(true);
  });

  it('formats as a major-unit decimal string', () => {
    expect(Money.of(12_345, 'NGN').toDecimal()).toBe('123.45');
    expect(Money.of(0, 'USD').toDecimal()).toBe('0.00');
  });
});
