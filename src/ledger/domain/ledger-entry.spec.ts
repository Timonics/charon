import { InvalidLedgerEntryError } from './errors';
import { LedgerEntry } from './ledger-entry';

function validInput(overrides: Record<string, unknown> = {}) {
  return {
    aggregateType: 'PaymentIntent',
    aggregateId: '3fa85f64-5717-4562-b3fc-2c963f66afa6',
    eventType: 'PaymentSucceeded',
    payload: { amount: 10_000, currency: 'NGN' },
    occurredAt: new Date('2026-09-21T12:00:00.000Z'),
    sequence: 1,
    ...overrides,
  };
}

describe('LedgerEntry.record', () => {
  it('creates an immutable entry with a generated entryId and recordedAt', () => {
    const entry = LedgerEntry.record(validInput());

    expect(entry.entryId).toMatch(/^[0-9a-f-]{36}$/);
    expect(entry.sequence).toBe(1);
    expect(entry.occurredAt.toISOString()).toBe('2026-09-21T12:00:00.000Z');
    expect(entry.recordedAt).toBeInstanceOf(Date);
    expect(Object.isFrozen(entry)).toBe(true);
  });

  it.each([
    ['empty aggregateType', { aggregateType: '  ' }],
    ['empty aggregateId', { aggregateId: '' }],
    ['empty eventType', { eventType: '' }],
    ['zero sequence', { sequence: 0 }],
    ['negative sequence', { sequence: -1 }],
    ['fractional sequence', { sequence: 1.5 }],
    ['invalid occurredAt', { occurredAt: new Date('not a date') }],
    ['function payload', { payload: () => 1 }],
    ['bigint payload', { payload: { amount: 10n } }],
    [
      'circular payload',
      {
        payload: (() => {
          const o: Record<string, unknown> = {};
          o.self = o;
          return o;
        })(),
      },
    ],
    ['undefined payload', { payload: undefined }],
  ])('rejects %s', (_label, overrides) => {
    expect(() => LedgerEntry.record(validInput(overrides))).toThrow(
      InvalidLedgerEntryError,
    );
  });

  it('accepts a payload with null and nested arrays', () => {
    const entry = LedgerEntry.record(
      validInput({ payload: { note: null, refs: ['a', { b: 1 }] } }),
    );
    expect(entry.payload).toEqual({ note: null, refs: ['a', { b: 1 }] });
  });

  it('freezes the payload graph so mutations are impossible, not silent', () => {
    const source = { nested: { amount: 10_000 } };
    const entry = LedgerEntry.record(validInput({ payload: source }));

    // Mutating the caller's original must not affect the journaled copy.
    source.nested.amount = 0;
    expect(
      (entry.payload as { nested: { amount: number } }).nested.amount,
    ).toBe(10_000);
    expect(Object.isFrozen((entry.payload as { nested: unknown }).nested)).toBe(
      true,
    );
  });

  it('clones the payload so later caller mutations cannot rewrite history', () => {
    const source = { amounts: [1, 2, 3] };
    const entry = LedgerEntry.record(validInput({ payload: source }));
    source.amounts.push(4);
    expect((entry.payload as { amounts: number[] }).amounts).toEqual([1, 2, 3]);
  });
});
