/**
 * node-postgres returns BIGINT columns as STRINGS (a deliberate choice in
 * the driver: JS numbers lose integer precision above 2^53). Every monetary
 * and sequence column in this schema is BIGINT, so every adapter funnels
 * through here before touching domain code.
 *
 * The validation is not ceremony: silently producing a NaN or a rounded
 * value from a money column would corrupt the one thing this service exists
 * to get right.
 */
export function toSafeInteger(raw: string | number, column: string): number {
  const value = typeof raw === 'string' ? Number(raw) : raw;
  if (!Number.isSafeInteger(value)) {
    throw new Error(`column ${column} is not a safe integer: ${String(raw)}`);
  }
  return value;
}

/**
 * `char(n)` columns come back space-padded from Postgres. Trim before
 * using as a value object (currency codes, fixed-length codes).
 */
export function trimChar(raw: string): string {
  return raw.trim();
}
