import { DomainError } from '../../shared/kernel/domain-error';
import { err, ok, type Result } from '../../shared/kernel/result';

/**
 * The closed set of payment methods the service understands.
 *
 * Modeled as a closed union (not free text from the API layer) because the
 * routing matrix and each provider adapter must handle every method
 * explicitly. A method this service does not know about must fail at the
 * interface-layer validation stage (zod), long before it reaches the domain.
 */
export const PAYMENT_METHODS = [
  'card',
  'bank_transfer',
  'ussd',
  'mobile_money',
] as const;

export type PaymentMethod = (typeof PAYMENT_METHODS)[number];

export class UnknownPaymentMethodError extends DomainError {
  readonly code = 'UNKNOWN_PAYMENT_METHOD';

  constructor(raw: string) {
    super(
      `Unknown payment method: "${raw}". Expected one of: ${PAYMENT_METHODS.join(', ')}`,
    );
  }
}

/**
 * Validates an untrusted string (HTTP payload, persisted row) into the
 * {@link PaymentMethod} union.
 */
export function parsePaymentMethod(
  raw: string,
): Result<PaymentMethod, UnknownPaymentMethodError> {
  const normalized = raw.trim().toLowerCase();
  if ((PAYMENT_METHODS as readonly string[]).includes(normalized)) {
    return ok(normalized as PaymentMethod);
  }
  return err(new UnknownPaymentMethodError(raw));
}
