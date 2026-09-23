import { Money } from '../../shared/kernel/money';
import {
  parseIdempotencyKey,
  type IdempotencyKey,
} from '../../shared/kernel/idempotency-key';
import {
  IllegalPaymentStatusTransitionError,
  InvalidPaymentIntentError,
  RefundExceedsChargedAmountError,
  RefundNotAllowedError,
} from './errors';
import {
  PaymentFailed,
  PaymentInitiated,
  PaymentSucceeded,
  RefundIssued,
} from './events';
import { PaymentIntent, type CreatePaymentIntentInput } from './payment-intent';

/** Unwraps a fixture key; fails the test loudly if the fixture itself is wrong. */
function idempotencyKey(raw: string): IdempotencyKey {
  const result = parseIdempotencyKey(raw);
  if (!result.ok)
    throw new Error(`fixture idempotency key must be valid: ${raw}`);
  return result.value;
}

const IDEMPOTENCY_KEY = idempotencyKey('test-intent-0001');

function makeInput(
  overrides: Partial<CreatePaymentIntentInput> = {},
): CreatePaymentIntentInput {
  return {
    amount: Money.of(10_000, 'NGN'),
    method: 'card',
    provider: 'paystack',
    idempotencyKey: IDEMPOTENCY_KEY,
    ...overrides,
  };
}

/** Walks a fresh intent to SUCCEEDED the only legal way. */
function succeededIntent(): PaymentIntent {
  const intent = PaymentIntent.create(makeInput());
  intent.markProcessing('PAYSTACK-CHARGE-REF-1');
  intent.markSucceeded();
  return intent;
}

describe('PaymentIntent.create', () => {
  it('creates an intent in INITIATED with a recorded PaymentInitiated event', () => {
    const intent = PaymentIntent.create(makeInput());

    expect(intent.currentStatus).toBe('INITIATED');
    expect(intent.chargeReference).toBeUndefined();

    const events = intent.pullEvents();
    expect(events).toHaveLength(1);
    expect(events[0]).toBeInstanceOf(PaymentInitiated);
    const initiated = events[0] as PaymentInitiated;
    expect(initiated.amount.equals(Money.of(10_000, 'NGN'))).toBe(true);
    expect(initiated.provider).toBe('paystack');
    expect(initiated.idempotencyKey).toBe(IDEMPOTENCY_KEY);
  });

  it('rejects a zero amount', () => {
    expect(() =>
      PaymentIntent.create(makeInput({ amount: Money.zero('NGN') })),
    ).toThrow(InvalidPaymentIntentError);
  });

  it('drains events on pull; a second pull returns nothing', () => {
    const intent = PaymentIntent.create(makeInput());
    expect(intent.pullEvents()).toHaveLength(1);
    expect(intent.pullEvents()).toHaveLength(0);
  });
});

describe('PaymentIntent lifecycle transitions', () => {
  it('walks the happy path INITIATED → PROCESSING → SUCCEEDED', () => {
    const intent = PaymentIntent.create(makeInput());
    intent.markProcessing('PAYSTACK-CHARGE-REF-1');
    expect(intent.currentStatus).toBe('PROCESSING');
    expect(intent.chargeReference).toBe('PAYSTACK-CHARGE-REF-1');

    intent.markSucceeded();
    expect(intent.currentStatus).toBe('SUCCEEDED');

    const events = intent.pullEvents();
    // Buffer holds [PaymentInitiated, PaymentSucceeded] — create() was never drained.
    expect(events[1]).toBeInstanceOf(PaymentSucceeded);
    expect((events[1] as PaymentSucceeded).providerChargeRef).toBe(
      'PAYSTACK-CHARGE-REF-1',
    );
  });

  it('allows FAILED and EXPIRED directly from INITIATED', () => {
    const failed = PaymentIntent.create(makeInput());
    failed.markFailed('provider declined');
    expect(failed.currentStatus).toBe('FAILED');
    expect(failed.pullEvents()[1]).toBeInstanceOf(PaymentFailed);

    const expired = PaymentIntent.create(makeInput());
    expired.expire();
    expect(expired.currentStatus).toBe('EXPIRED');
  });

  it('rejects skipping PROCESSING: INITIATED → SUCCEEDED is illegal', () => {
    const intent = PaymentIntent.create(makeInput());
    expect(() => intent.markSucceeded()).toThrow(
      IllegalPaymentStatusTransitionError,
    );
  });

  it('rejects empty provider charge references', () => {
    const intent = PaymentIntent.create(makeInput());
    expect(() => intent.markProcessing('   ')).toThrow(
      InvalidPaymentIntentError,
    );
  });

  it.each([
    [
      'FAILED',
      (i: PaymentIntent) => i.markFailed('x'),
      (i: PaymentIntent) => i.markSucceeded(),
    ],
    [
      'EXPIRED',
      (i: PaymentIntent) => i.expire(),
      (i: PaymentIntent) => i.markProcessing('ref'),
    ],
    [
      'SUCCEEDED',
      (i: PaymentIntent) => {
        i.markProcessing('ref');
        i.markSucceeded();
      },
      (i: PaymentIntent) => i.markFailed('too late'),
    ],
  ])('freezes the %s terminal state', (_label, reachTerminal, mutate) => {
    const intent = PaymentIntent.create(makeInput());
    reachTerminal(intent);
    expect(() => mutate(intent)).toThrow(IllegalPaymentStatusTransitionError);
  });
});

describe('PaymentIntent refunds', () => {
  it('allows partial refunds and tracks the cumulative total', () => {
    const intent = succeededIntent();

    intent.recordRefund(Money.of(2_500, 'NGN'));
    intent.recordRefund(Money.of(1_000, 'NGN'));

    expect(intent.refundedToDate.amount).toBe(3_500);
    expect(intent.availableAmount.amount).toBe(6_500);

    const events = intent.pullEvents();
    const refunds = events.filter((e) => e instanceof RefundIssued);
    expect(refunds).toHaveLength(2);
    expect(refunds[0].amount.amount).toBe(2_500);
    expect(refunds[0].refundedToDate.amount).toBe(2_500);
    expect(refunds[1].refundedToDate.amount).toBe(3_500);
  });

  it('rejects a refund that would exceed the charged amount', () => {
    const intent = succeededIntent();
    intent.recordRefund(Money.of(6_000, 'NGN'));
    expect(() => intent.recordRefund(Money.of(4_001, 'NGN'))).toThrow(
      RefundExceedsChargedAmountError,
    );
    // A refund up to exactly the charged amount is fine.
    intent.recordRefund(Money.of(4_000, 'NGN'));
    expect(intent.refundedToDate.amount).toBe(10_000);
  });

  it('rejects refunds before settlement', () => {
    const intent = PaymentIntent.create(makeInput());
    expect(() => intent.recordRefund(Money.of(1, 'NGN'))).toThrow(
      RefundNotAllowedError,
    );

    intent.markProcessing('ref');
    expect(() => intent.recordRefund(Money.of(1, 'NGN'))).toThrow(
      RefundNotAllowedError,
    );
  });

  it('rejects zero-amount refunds and cross-currency refunds', () => {
    const intent = succeededIntent();
    expect(() => intent.recordRefund(Money.zero('NGN'))).toThrow(
      InvalidPaymentIntentError,
    );
    expect(() => intent.recordRefund(Money.of(1, 'USD'))).toThrow(); // CurrencyMismatchError from Money
  });
});
