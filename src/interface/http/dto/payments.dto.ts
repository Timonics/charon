/**
 * HTTP DTOs for the `payments` surface.
 *
 * Inbound: `InitiatePaymentRequestDto` is the JSON body the operator
 * (or their caller) sends to `POST /payments`. It maps 1:1 to
 * `InitiatePaymentCommand` from the application layer; the controller
 * does the translation (mostly a rename from camelCase to the field
 * names the use case expects).
 *
 * Outbound: `InitiatePaymentResponseDto` is the JSON the service
 * returns on 200 / 201. It is the same shape as
 * `InitiatePaymentResult` (the use case's plain-data result) with
 * the field types narrowed for JSON serialization.
 *
 * Both DTOs use `class-validator` decorators so the inbound body is
 * rejected at the boundary if it doesn't match the contract. The
 * `forbidNonWhitelisted: true` flag on the global ValidationPipe
 * means an extra field is also a 400, not a silent ignore.
 */
import {
  IsEmail,
  IsIn,
  IsInt,
  IsISO4217CurrencyCode,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUrl,
  Length,
  Matches,
  Min,
} from 'class-validator';

const PAYMENT_METHODS = [
  'card',
  'bank_transfer',
  'ussd',
  'mobile_money',
] as const;
export type PaymentMethodDto = (typeof PAYMENT_METHODS)[number];

const CARD_ORIGINS = ['nigeria', 'international', 'unknown'] as const;
export type CardOriginDto = (typeof CARD_ORIGINS)[number];

export class InitiatePaymentRequestDto {
  /** Integer minor units (kobo/cents). Must be a positive integer. */
  @IsInt()
  @Min(1)
  amountMinor!: number;

  /** ISO 4217 code, e.g. 'NGN'. Three uppercase letters. */
  @IsString()
  @IsISO4217CurrencyCode()
  currency!: string;

  /** Payment method. The closed set routes the use case to a provider. */
  @IsIn(PAYMENT_METHODS)
  method!: PaymentMethodDto;

  /**
   * Caller-generated idempotency key. The service caches the result
   * for replay; the same key returns the same result. Format is
   * 16-128 chars of `[A-Za-z0-9._-]`.
   */
  @IsString()
  @Length(16, 128)
  @Matches(/^[A-Za-z0-9._-]+$/, {
    message:
      'idempotencyKey must match /^[A-Za-z0-9._-]+$/ (16-128 chars). ' +
      'Letters, digits, dot, underscore, hyphen only.',
  })
  idempotencyKey!: string;

  /** Opaque reference to the caller's customer (their user id, etc.). */
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @Length(1, 256)
  customerRef?: string;

  /** Free-text purpose; audit/logging only, never branched on. */
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @Length(1, 1024)
  description?: string;

  /**
   * Customer email — required by every supported provider's
   * charge API. Optional in the DTO; the gateway adapter surfaces
   * a ProviderApiError if absent when the provider requires it.
   */
  @IsOptional()
  @IsEmail()
  customerEmail?: string;

  /** Where the provider should redirect after a hosted page. */
  @IsOptional()
  @IsUrl({ require_protocol: true })
  callbackUrl?: string;

  /** Optional BIN-derived hint used only for card routing. */
  @IsOptional()
  @IsIn(CARD_ORIGINS)
  cardOrigin?: CardOriginDto;
}

export class InitiatePaymentResponseDto {
  intentId!: string;
  status!: string;
  provider!: string;
  providerReference!: string;
  amountMinor!: number;
  currency!: string;
  method!: string;

  static from(result: {
    readonly intentId: string;
    readonly status: string;
    readonly provider: string;
    readonly providerReference: string;
    readonly amountMinor: number;
    readonly currency: string;
    readonly method: string;
  }): InitiatePaymentResponseDto {
    const dto = new InitiatePaymentResponseDto();
    dto.intentId = result.intentId;
    dto.status = result.status;
    dto.provider = result.provider;
    dto.providerReference = result.providerReference;
    dto.amountMinor = result.amountMinor;
    dto.currency = result.currency;
    dto.method = result.method;
    return dto;
  }
}
