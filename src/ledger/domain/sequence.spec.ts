import { SequenceGapError } from './errors';
import { assertNextSequence, FIRST_SEQUENCE, isNextSequence } from './sequence';

describe('isNextSequence', () => {
  it('treats the first entry as sequence 1', () => {
    expect(isNextSequence(undefined, FIRST_SEQUENCE)).toBe(true);
    expect(isNextSequence(undefined, 2)).toBe(false);
  });

  it('accepts exactly last + 1', () => {
    expect(isNextSequence(1, 2)).toBe(true);
    expect(isNextSequence(41, 42)).toBe(true);
  });

  it.each([
    [1, 1], // duplicate
    [1, 3], // skipped
    [5, 4], // out of order
  ])('rejects last=%p next=%p', (last, next) => {
    expect(isNextSequence(last, next)).toBe(false);
  });
});

describe('assertNextSequence', () => {
  it('passes silently for the legal successor', () => {
    expect(() =>
      assertNextSequence('PaymentIntent', 'agg-1', 7, 8),
    ).not.toThrow();
  });

  it('throws a SequenceGapError carrying expected and received', () => {
    try {
      assertNextSequence('Escrow', 'agg-9', 7, 10);
      throw new Error('should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(SequenceGapError);
      const gap = error as SequenceGapError;
      expect(gap.aggregateType).toBe('Escrow');
      expect(gap.aggregateId).toBe('agg-9');
      expect(gap.expected).toBe(8);
      expect(gap.received).toBe(10);
    }
  });
});
