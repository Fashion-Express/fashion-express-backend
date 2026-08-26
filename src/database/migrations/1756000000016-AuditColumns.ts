import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Uniform audit columns across the business tables:
 * `is_active`, `created_at`, `updated_at`, `created_by_id`, `updated_by_id`.
 *
 * Three decisions are baked in here and each was a real choice:
 *
 * **1. The user columns are foreign keys, not copied usernames.** A
 * `varchar(255) created_by` is precisely deviation D-06, which REQUIREMENTS.MD
 * §9 lists as a defect to be closed: a copied name leaves the row
 * unattributable the moment the account is renamed. Hardening item H-13 says
 * the same. They are also **nullable**, because a great many rows in this
 * system have no acting user — the ledger writes itself (BR-38), stock
 * movements are written by the system (BR-25), and the seed migration and the
 * rollup triggers have no session at all. A `NOT NULL` here would force a
 * fictional "system" user onto every one of those.
 *
 * **2. `is_active` is added everywhere it was asked for, including the
 * transactional tables — and it is purely additive.** Nothing reads it. The
 * authoritative state of a sale remains `status_code` (RD-03), which BR-03,
 * BR-07 and BR-14 all key on; a claim's remains its own `status_code` (RD-08).
 * `ledger_entries` and `stock_histories` stay append-only (BR-38, BR-25) — the
 * column exists there for uniformity, not as a licence to soft-delete, and
 * deactivating a ledger line would silently unbalance the books because the
 * balance sums every row.
 *
 * **3. Excluded tables.** `sessions`, `accounts` and `verifications` belong to
 * better-auth, which inserts into them itself and knows nothing of these
 * columns; `migrations` belongs to TypeORM; `customer_id_sequences` and
 * `sale_id_sequences` are singleton counters; `user_type_permissions` is a pure
 * join; `login_attempts` is transient. None of them describes a business record
 * with an author.
 */
export class AuditColumns1756000000016 implements MigrationInterface {
  name = 'AuditColumns1756000000016';

  public async up(queryRunner: QueryRunner): Promise<void> {
    for (const table of BUSINESS_TABLES) {
      // `IF NOT EXISTS` makes this a no-op wherever the column already exists,
      // so tables that already carried `created_at` or `is_active` keep exactly
      // the definition their own migration gave them.
      await queryRunner.query(`
        ALTER TABLE ${table}
          ADD COLUMN IF NOT EXISTS is_active  boolean     NOT NULL DEFAULT true,
          ADD COLUMN IF NOT EXISTS created_at timestamptz NOT NULL DEFAULT now(),
          ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now(),
          ADD COLUMN IF NOT EXISTS created_by_id bigint NULL
            REFERENCES users(id) ON DELETE SET NULL DEFERRABLE INITIALLY DEFERRED,
          ADD COLUMN IF NOT EXISTS updated_by_id bigint NULL
            REFERENCES users(id) ON DELETE SET NULL DEFERRABLE INITIALLY DEFERRED
      `);

      // Attribution is looked up by user often enough ("what did this person
      // change?") to be worth an index, and a foreign key with no index makes
      // deleting a user scan every referencing table.
      await queryRunner.query(
        `CREATE INDEX IF NOT EXISTS idx_${table}_created_by ON ${table} (created_by_id)`,
      );
      await queryRunner.query(
        `CREATE INDEX IF NOT EXISTS idx_${table}_updated_by ON ${table} (updated_by_id)`,
      );
    }

    /**
     * `updated_at` is maintained by a trigger rather than by application code.
     *
     * This is the same argument §11 makes for the rollup columns: maintaining a
     * derived value in the service layer works for every path the application
     * controls and fails for every path it does not — a bulk update, a data
     * migration, a fix applied in psql. An `updated_at` that only sometimes
     * updates is worse than none, because it looks authoritative.
     */
    await queryRunner.query(`
      CREATE OR REPLACE FUNCTION fe_touch_updated_at() RETURNS trigger
      LANGUAGE plpgsql AS $$
      BEGIN
          NEW.updated_at := now();
          RETURN NEW;
      END;
      $$;
    `);

    for (const table of BUSINESS_TABLES) {
      await queryRunner.query(
        `DROP TRIGGER IF EXISTS trg_${table}_touch ON ${table}`,
      );
      await queryRunner.query(`
        CREATE TRIGGER trg_${table}_touch
            BEFORE UPDATE ON ${table}
            FOR EACH ROW EXECUTE FUNCTION fe_touch_updated_at();
      `);
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    for (const table of BUSINESS_TABLES) {
      await queryRunner.query(
        `DROP TRIGGER IF EXISTS trg_${table}_touch ON ${table}`,
      );
    }
    await queryRunner.query(`DROP FUNCTION IF EXISTS fe_touch_updated_at()`);

    for (const table of BUSINESS_TABLES) {
      /**
       * Drop only what this migration actually added.
       *
       * A column listed in PRE_EXISTING belongs to its own table's original
       * definition — `sales.created_by_id` is the salesperson who raised the
       * sale (FR-02.8), not an audit artefact, and `units.is_active` is what
       * BR-60 retires a reference entry with. Dropping either on a rollback
       * would destroy real data and take the constraint with it.
       */
      const columns = ['updated_by_id'];
      if (!PRE_EXISTING.isActive.includes(table)) columns.push('is_active');
      if (!PRE_EXISTING.createdAt.includes(table)) columns.push('created_at');
      if (!PRE_EXISTING.updatedAt.includes(table)) columns.push('updated_at');
      if (!PRE_EXISTING.createdBy.includes(table))
        columns.push('created_by_id');

      await queryRunner.query(
        `ALTER TABLE ${table} ${columns
          .map((c) => `DROP COLUMN IF EXISTS ${c}`)
          .join(', ')}`,
      );
    }
  }
}

/**
 * The business tables. Deliberately an explicit list rather than a query over
 * `pg_tables`: which tables describe a business record is a judgement, and it
 * should be reviewable here rather than inferred at run time.
 */
const BUSINESS_TABLES = [
  // reference data (§23)
  'user_types',
  'job_positions',
  'departments',
  'categories',
  'expense_categories',
  'units',
  'transaction_types',
  'item_types',
  'payment_methods',
  'ledger_entry_types',
  'ledger_sources',
  'statuses',
  'permissions',
  // identity and shops
  'users',
  'shops',
  // trading
  'customers',
  'inventory_items',
  'stock_histories',
  'sales',
  'sale_items',
  'sale_payments',
  'customer_payment_batches',
  'customer_payment_allocations',
  // buying
  'suppliers',
  'supplier_purchases',
  'supplier_purchase_payments',
  // money out
  'expenses',
  'bill_claims',
  'ledger_entries',
] as const;

/** What each table already had before this migration, so `down` is honest. */
const PRE_EXISTING = {
  isActive: [
    'user_types',
    'job_positions',
    'departments',
    'categories',
    'expense_categories',
    'units',
    'transaction_types',
    'item_types',
    'payment_methods',
    'ledger_entry_types',
    'ledger_sources',
    'statuses',
    'users',
    'shops',
  ] as string[],
  createdAt: [
    'user_types',
    'job_positions',
    'departments',
    'categories',
    'expense_categories',
    'permissions',
    'users',
    'shops',
    'customers',
    'inventory_items',
    'stock_histories',
    'sales',
    'sale_payments',
    'customer_payment_batches',
    'customer_payment_allocations',
    'suppliers',
    'supplier_purchases',
    'supplier_purchase_payments',
    'expenses',
    'bill_claims',
  ] as string[],
  updatedAt: [
    'user_types',
    'job_positions',
    'departments',
    'categories',
    'expense_categories',
    'users',
    'shops',
    'customers',
    'inventory_items',
    'sales',
    'sale_payments',
    'suppliers',
    'supplier_purchases',
    'supplier_purchase_payments',
    'expenses',
    'bill_claims',
  ] as string[],
  createdBy: [
    'sales',
    'stock_histories',
    'customer_payment_batches',
  ] as string[],
};
