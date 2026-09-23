import { Money } from '../../shared/kernel/money';
import {
  InvalidEscrowOperationError,
  IllegalEscrowStateTransitionError,
} from './errors';
import { Escrow, type CreateEscrowInput } from './escrow';
import {
  EscrowCancelled,
  EscrowDisputed,
  EscrowExpired,
  EscrowHeld,
  EscrowInitiated,
  EscrowReleased,
  EscrowResolved,
} from './events';

const INTENT_ID = '3fa85f64-5717-4562-b3fc-2c963f66afa6';

function makeInput(
  overrides: Partial<CreateEscrowInput> = {},
): CreateEscrowInput {
  return {
    paymentIntentId: INTENT_ID,
    heldAmount: Money.of(10_000, 'NGN'),
    provider: 'paystack',
    ...overrides,
  };
}

/** PENDING → HELD the only legal way. */
function heldEscrow(): Escrow {
  const escrow = Escrow.create(makeInput());
  escrow.hold('PAYSTACK-SUBACCT-1');
  return escrow;
}

describe('Escrow.create', () => {
  it('registers a PENDING escrow and journals EscrowInitiated', () => {
    const escrow = Escrow.create(makeInput());

    expect(escrow.currentState).toBe('PENDING');
    expect(escrow.custodyReference).toBeUndefined();
    expect(escrow.availableAmount.amount).toBe(10_000);

    const events = escrow.pullEvents();
    expect(events).toHaveLength(1);
    expect(events[0]).toBeInstanceOf(EscrowInitiated);
    expect((events[0] as EscrowInitiated).paymentIntentId).toBe(INTENT_ID);
    expect((events[0] as EscrowInitiated).heldAmount.amount).toBe(10_000);
  });

  it('rejects a zero held amount and an empty intent reference', () => {
    expect(() =>
      Escrow.create(makeInput({ heldAmount: Money.zero('NGN') })),
    ).toThrow(InvalidEscrowOperationError);
    expect(() => Escrow.create(makeInput({ paymentIntentId: '  ' }))).toThrow(
      InvalidEscrowOperationError,
    );
  });
});

describe('Escrow.hold', () => {
  it('moves PENDING → HELD and records the custody reference', () => {
    const escrow = heldEscrow();

    expect(escrow.currentState).toBe('HELD');
    expect(escrow.custodyReference).toBe('PAYSTACK-SUBACCT-1');

    const events = escrow.pullEvents();
    expect(events[1]).toBeInstanceOf(EscrowHeld);
    expect((events[1] as EscrowHeld).providerCustodyRef).toBe(
      'PAYSTACK-SUBACCT-1',
    );
  });

  it('requires a non-empty custody reference', () => {
    const escrow = Escrow.create(makeInput());
    expect(() => escrow.hold('')).toThrow(InvalidEscrowOperationError);
  });

  it('cannot be held twice', () => {
    const escrow = heldEscrow();
    expect(() => escrow.hold('OTHER-REF')).toThrow(
      IllegalEscrowStateTransitionError,
    );
  });
});

describe('Escrow partial releases (the day-one feature)', () => {
  it('supports a 70/30 split across two releases, staying HELD until fully consumed', () => {
    const escrow = heldEscrow();

    escrow.release(Money.of(7_000, 'NGN'), 'seller-subacct-9', 'milestone 1');
    expect(escrow.currentState).toBe('HELD');
    expect(escrow.releasedToDate.amount).toBe(7_000);
    expect(escrow.availableAmount.amount).toBe(3_000);

    escrow.release(Money.of(3_000, 'NGN'), 'seller-subacct-9', 'milestone 2');
    expect(escrow.currentState).toBe('RELEASED');
    expect(escrow.releasedToDate.amount).toBe(10_000);
    expect(escrow.availableAmount.isZero()).toBe(true);

    const events = escrow.pullEvents();
    const released = events.filter((e) => e instanceof EscrowReleased);
    expect(released).toHaveLength(2);
    expect(released[0].amount.amount).toBe(7_000);
    expect(released[0].releasedToDate.amount).toBe(7_000);
    expect(released[0].recipientRef).toBe('seller-subacct-9');
    expect(released[1].releasedToDate.amount).toBe(10_000);
  });

  it('enforces released + refunded ≤ held across mixed movements', () => {
    const escrow = heldEscrow();

    escrow.release(Money.of(6_000, 'NGN'));
    escrow.refund(Money.of(4_000, 'NGN'));
    expect(escrow.currentState).toBe('REFUNDED'); // closed by a refund

    const over = heldEscrow();
    over.release(Money.of(6_000, 'NGN'));
    expect(() => over.refund(Money.of(4_001, 'NGN'))).toThrow(
      InvalidEscrowOperationError,
    );
    // Spending exactly the remainder is fine.
    over.refund(Money.of(4_000, 'NGN'));
    expect(over.currentState).toBe('REFUNDED');
  });

  it('a hold closed by a final release is RELEASED even after partial refunds', () => {
    const escrow = heldEscrow();
    escrow.refund(Money.of(2_000, 'NGN'));
    escrow.release(Money.of(8_000, 'NGN'));
    expect(escrow.currentState).toBe('RELEASED');
  });

  it('rejects zero amounts and cross-currency movements', () => {
    const escrow = heldEscrow();
    expect(() => escrow.release(Money.zero('NGN'))).toThrow(
      InvalidEscrowOperationError,
    );
    expect(() => escrow.refund(Money.zero('NGN'))).toThrow(
      InvalidEscrowOperationError,
    );
    expect(() => escrow.release(Money.of(1, 'USD'))).toThrow(); // CurrencyMismatchError
  });

  it('freezes terminal states: no movement after RELEASED or REFUNDED', () => {
    const released = heldEscrow();
    released.release(Money.of(10_000, 'NGN'));
    expect(() => released.release(Money.of(1, 'NGN'))).toThrow(
      IllegalEscrowStateTransitionError,
    );

    const refunded = heldEscrow();
    refunded.refund(Money.of(10_000, 'NGN'));
    expect(() => refunded.refund(Money.of(1, 'NGN'))).toThrow(
      IllegalEscrowStateTransitionError,
    );
  });
});

describe('Escrow dispute flow', () => {
  it('freezes a HELD escrow and resumes it on resolution', () => {
    const escrow = heldEscrow();

    escrow.dispute('buyer claims non-delivery');
    expect(escrow.currentState).toBe('DISPUTED');
    expect(() => escrow.release(Money.of(1_000, 'NGN'))).toThrow(
      IllegalEscrowStateTransitionError,
    );
    expect(() => escrow.refund(Money.of(1_000, 'NGN'))).toThrow(
      IllegalEscrowStateTransitionError,
    );

    escrow.resolveDispute();
    expect(escrow.currentState).toBe('HELD');

    // Movement resumes; totals were untouched by the freeze.
    escrow.release(Money.of(10_000, 'NGN'));
    expect(escrow.currentState).toBe('RELEASED');

    const events = escrow.pullEvents();
    expect(events.some((e) => e instanceof EscrowDisputed)).toBe(true);
    expect(events.some((e) => e instanceof EscrowResolved)).toBe(true);
  });

  it('requires a dispute reason and only disputes HELD escrows', () => {
    const pending = Escrow.create(makeInput());
    expect(() => pending.dispute('reason')).toThrow(
      IllegalEscrowStateTransitionError,
    );

    const held = heldEscrow();
    expect(() => held.dispute('  ')).toThrow(InvalidEscrowOperationError);
  });

  it('cannot be disputed again from DISPUTED', () => {
    const escrow = heldEscrow();
    escrow.dispute('first');
    expect(() => escrow.dispute('second')).toThrow(
      IllegalEscrowStateTransitionError,
    );
  });
});

describe('Escrow.cancel', () => {
  it('cancels only from PENDING', () => {
    const escrow = Escrow.create(makeInput());
    escrow.cancel('charge failed upstream');
    expect(escrow.currentState).toBe('CANCELLED');
    expect(escrow.pullEvents()[1]).toBeInstanceOf(EscrowCancelled);

    const held = heldEscrow();
    expect(() => held.cancel('changed my mind')).toThrow(
      IllegalEscrowStateTransitionError,
    );
  });
});

describe('Escrow.expire', () => {
  it('expires only from PENDING and journals an EscrowExpired event', () => {
    const escrow = Escrow.create(makeInput());
    escrow.expire('booking window lapsed');

    expect(escrow.currentState).toBe('EXPIRED');
    const events = escrow.pullEvents();
    expect(events[1]).toBeInstanceOf(EscrowExpired);
    expect((events[1] as EscrowExpired).reason).toBe('booking window lapsed');
  });

  it('refuses to expire a HELD escrow — funds are real, must leave via release/refund', () => {
    const held = heldEscrow();
    expect(() => held.expire('window lapsed')).toThrow(
      IllegalEscrowStateTransitionError,
    );
    expect(held.currentState).toBe('HELD');
  });

  it('refuses to expire a terminal escrow — history is append-only', () => {
    const escrow = Escrow.create(makeInput());
    escrow.cancel('voided');
    expect(() => escrow.expire('too late')).toThrow(
      IllegalEscrowStateTransitionError,
    );

    const held = heldEscrow();
    // held.cancel() is itself illegal (HELD has no CANCELLED edge); the
    // illegal cancel proves escrow is unchanged before expire even tries.
    expect(() => held.cancel('not allowed')).toThrow(
      IllegalEscrowStateTransitionError,
    );
    expect(held.currentState).toBe('HELD');
  });
});

describe('Escrow event draining', () => {
  it('drains once; a second pull returns nothing', () => {
    const escrow = heldEscrow();
    escrow.release(Money.of(5_000, 'NGN'));
    expect(escrow.pullEvents().length).toBe(3); // Initiated, Held, Released
    expect(escrow.pullEvents()).toHaveLength(0);
  });
});
