import { DomainError } from './domain-error';
import { err, ok, type Result } from './result';

export type IdempotencyKey = string & { readonly __brand: 'IdempotencyKey' };

export class InvalidIdempotencyKeyError extends DomainError {
  readonly code = 'INVALID_IDEMPOTENCY_KEY';

  constructor() {
    super(
      'Idempotency key must be 8–128 characters of [A-Za-z0-9._:-], starting with an alphanumeric character',
    );
  }
}

const KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/;

export function parseIdempotencyKey(
  raw: string,
): Result<IdempotencyKey, InvalidIdempotencyKeyError> {
  if (typeof raw !== 'string' || !KEY_PATTERN.test(raw)) {
    return err(new InvalidIdempotencyKeyError());
  }
  return ok(raw as IdempotencyKey);
}
