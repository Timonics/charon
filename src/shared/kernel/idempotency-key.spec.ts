import {
  InvalidIdempotencyKeyError,
  parseIdempotencyKey,
} from './idempotency-key';

describe('parseIdempotencyKey', () => {
  it('accepts valid keys', () => {
    const result = parseIdempotencyKey('order-123:abc._-XY');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toBe('order-123:abc._-XY');
    }
  });

  it.each([
    ['too short'],
    ['a'.repeat(129)],
    ['has space1'],
    ['bad/slash'],
    [''],
    ['-leading-hyphen'],
  ])('rejects invalid key %j', (raw) => {
    const result = parseIdempotencyKey(raw);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBeInstanceOf(InvalidIdempotencyKeyError);
    }
  });

  it('accepts keys at the length boundaries', () => {
    expect(parseIdempotencyKey('a'.repeat(8)).ok).toBe(true);
    expect(parseIdempotencyKey('a'.repeat(128)).ok).toBe(true);
  });
});
