/**
 * Adds a `version` column to payment_intents and escrows for optimistic
 * concurrency. Without this, two concurrent release-escrow calls can
 * both pass the in-memory invariant check and over-release a held
 * amount. With it, the second concurrent UPDATE matches zero rows
 * (because the first one bumped the version) and the use case's
 * UnitOfWork rolls back.
 *
 * The version is bumped by the Postgres repository on every successful
 * UPDATE. Existing rows get version=0 via the DEFAULT clause, so the
 * migration is backwards-compatible with whatever data is already in
 * the table.
 *
 * @param {import('node-pg-migrate').MigrationBuilder} pgm
 */
exports.up = (pgm) => {
  pgm.addColumn('payment_intents', {
    version: { type: 'bigint', notNull: true, default: 0 },
  })
  pgm.addColumn('escrows', {
    version: { type: 'bigint', notNull: true, default: 0 },
  })
}

/**
 * @param {import('node-pg-migrate').MigrationBuilder} pgm
 */
exports.down = (pgm) => {
  pgm.dropColumn('escrows', 'version')
  pgm.dropColumn('payment_intents', 'version')
}
