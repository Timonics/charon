/**
 * Adds a `tenant_id` column to payment_intents and escrows.
 *
 * The `tenant_id` is the Cerberus `Organization.id` UUID (V1.6's
 * `App.defaultOrgSlug` resolved to a UUID). Every payment and
 * every escrow is owned by exactly one tenant; the column is
 * NOT NULL because there is no business state that is "owned
 * by nobody".
 *
 * Indexes:
 *   - The (tenant_id, intent_id) and (tenant_id, escrow_id) lookup
 *     paths are the hot read paths once multi-tenant queries are
 *     in scope. A btree on tenant_id alone covers the
 *     "list-all-intents-for-an-org" case.
 *   - The (tenant_id, provider, provider_charge_ref) index on
 *     payment_intents supports the webhook-reconciliation
 *     lookup (rebuild an intent from provider + tenant +
 *     charge_ref when the inbox republishes a stuck event).
 *
 * Backfill: this migration runs on a fresh database — no rows
 * exist yet. The PR-NN1 cutover assumes the migration is the
 * source of truth for the schema. The downstream migration
 * (PR-NN2's auth wiring) cannot run before this one, because
 * the VOs / aggregates / repos in PR-NN1 will not compile
 * against the older schema.
 *
 * The version column from the prior migration is left alone
 * (this migration does not touch it).
 *
 * @param {import('node-pg-migrate').MigrationBuilder} pgm
 */
exports.up = (pgm) => {
  pgm.addColumn('payment_intents', {
    tenant_id: { type: 'uuid', notNull: true },
  });
  pgm.addColumn('escrows', {
    tenant_id: { type: 'uuid', notNull: true },
  });

  // Hot read path: "give me all intents / escrows for this org".
  pgm.createIndex('payment_intents', 'tenant_id');
  pgm.createIndex('escrows', 'tenant_id');

  // Webhook reconciliation: lookup by (tenant, provider, ref).
  // Replaces the (provider, provider_charge_ref) index for V2
  // multi-tenant reads, but kept alongside for backwards compat
  // with V1 reads that don't filter by tenant. (V1 deployments
  // can drop the older index after PR-NN2 ships — see follow-up.)
  pgm.createIndex('payment_intents', [
    'tenant_id',
    'provider',
    'provider_charge_ref',
  ]);
  pgm.createIndex('escrows', ['tenant_id', 'provider', 'provider_custody_ref']);
}

/**
 * @param {import('node-pg-migrate').MigrationBuilder} pgm
 */
exports.down = (pgm) => {
  pgm.dropIndex('escrows', ['tenant_id', 'provider', 'provider_custody_ref']);
  pgm.dropIndex('payment_intents', [
    'tenant_id',
    'provider',
    'provider_charge_ref',
  ]);
  pgm.dropIndex('escrows', 'tenant_id');
  pgm.dropIndex('payment_intents', 'tenant_id');
  pgm.dropColumn('escrows', 'tenant_id');
  pgm.dropColumn('payment_intents', 'tenant_id');
}
