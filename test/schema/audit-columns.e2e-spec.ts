import { loadFixture, migrateTestDatabase, query, closePool } from './harness';

/**
 * The uniform audit columns (migration 016).
 *
 * The point of these tests is less "the columns exist" — a migration either ran
 * or it did not — than that adding them changed nothing else: the `updated_at`
 * trigger has to coexist with `sale_items`' generated column and with the
 * rollup triggers, and `sales.created_by_id` had to survive as the salesperson
 * rather than being replaced by an audit column of the same name.
 */

jest.setTimeout(60_000);

/** Every table the migration claims to cover. */
const BUSINESS_TABLES = [
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
  'users',
  'shops',
  'customers',
  'inventory_items',
  'stock_histories',
  'sales',
  'sale_items',
  'sale_payments',
  'customer_payment_batches',
  'customer_payment_allocations',
  'suppliers',
  'supplier_purchases',
  'supplier_purchase_payments',
  'expenses',
  'bill_claims',
  'ledger_entries',
];

/** Tables that must NOT have been touched, and why. */
const EXCLUDED = [
  'sessions',
  'accounts',
  'verifications', // better-auth writes these itself
  'migrations', // TypeORM owns it
  'customer_id_sequences',
  'sale_id_sequences', // singleton counters
  'user_type_permissions', // a pure join
  'login_attempts', // transient
];

beforeAll(async () => {
  await migrateTestDatabase();
  await loadFixture();
});

afterAll(async () => {
  await closePool();
});

describe('coverage', () => {
  it('every business table carries all five columns', async () => {
    const rows = await query<{ tablename: string; missing: string }>(
      `SELECT t.tablename,
              array_to_string(ARRAY(
                SELECT c FROM unnest(ARRAY['is_active','created_at','updated_at',
                                           'created_by_id','updated_by_id']) AS c
                 WHERE NOT EXISTS (
                   SELECT 1 FROM information_schema.columns ic
                    WHERE ic.table_name = t.tablename AND ic.column_name = c)
              ), ',') AS missing
         FROM pg_tables t
        WHERE t.schemaname = 'public' AND t.tablename = ANY($1)`,
      [BUSINESS_TABLES],
    );

    expect(rows).toHaveLength(BUSINESS_TABLES.length);
    expect(rows.filter((r) => r.missing !== '')).toEqual([]);
  });

  it('leaves the system and better-auth tables alone', async () => {
    const rows = await query<{ table_name: string }>(
      `SELECT DISTINCT table_name FROM information_schema.columns
        WHERE table_name = ANY($1) AND column_name IN ('created_by_id','updated_by_id')`,
      [EXCLUDED],
    );
    expect(rows).toEqual([]);
  });

  it('attributes by reference, not by a copied username (D-06, H-13)', async () => {
    const rows = await query<{ data_type: string }>(
      `SELECT data_type FROM information_schema.columns
        WHERE column_name IN ('created_by_id','updated_by_id')
          AND table_schema = 'public'`,
    );
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r) => r.data_type === 'bigint')).toBe(true);

    // And no table reintroduced the varchar form the requirements call a defect.
    const copied = await query(
      `SELECT table_name FROM information_schema.columns
        WHERE table_schema = 'public' AND column_name IN ('created_by','updated_by')`,
    );
    expect(copied).toEqual([]);
  });
});

describe('updated_at is maintained by the database', () => {
  it('advances on update without the application setting it', async () => {
    await query(`UPDATE shops SET description = 'first' WHERE id = 1`);
    const before = await query<{ updated_at: string }>(
      `SELECT updated_at FROM shops WHERE id = 1`,
    );

    await query(`SELECT pg_sleep(0.01)`);
    await query(`UPDATE shops SET description = 'second' WHERE id = 1`);

    const after = await query<{ updated_at: string }>(
      `SELECT updated_at FROM shops WHERE id = 1`,
    );
    expect(new Date(after[0].updated_at).getTime()).toBeGreaterThan(
      new Date(before[0].updated_at).getTime(),
    );
  });

  /**
   * `sale_items.line_total` is `GENERATED ALWAYS AS … STORED`. A BEFORE UPDATE
   * trigger assigning to a *different* column has to leave it alone — if the
   * two ever conflict, line totals stop recomputing and every invoice is wrong.
   */
  it('coexists with the generated line_total and the rollup', async () => {
    const item = await query<{ id: string }>(
      `INSERT INTO sale_items (sale_id, shop_id, item_type_id, item_type_code,
                               inventory_item_id, quantity, unit_price)
       SELECT 1, 1, (SELECT id FROM item_types WHERE code='inventory'),
              'inventory', 1, 4, 25
       RETURNING id::text`,
    );

    let line = await query<{ line_total: string }>(
      `SELECT line_total FROM sale_items WHERE id = $1`,
      [item[0].id],
    );
    expect(line[0].line_total).toBe('100.00');

    await query(`UPDATE sale_items SET quantity = 6 WHERE id = $1`, [
      item[0].id,
    ]);

    line = await query<{ line_total: string; touched: boolean }>(
      `SELECT line_total, updated_at > created_at AS touched
         FROM sale_items WHERE id = $1`,
      [item[0].id],
    );
    expect(line[0].line_total).toBe('150.00');
    expect((line[0] as unknown as { touched: boolean }).touched).toBe(true);

    const sale = await query<{ total_amount: string }>(
      `SELECT total_amount FROM sales WHERE id = 1`,
    );
    expect(sale[0].total_amount).toBe('150.00');

    await query(`DELETE FROM sale_items WHERE id = $1`, [item[0].id]);
  });
});

describe('what the audit columns did not disturb', () => {
  /**
   * `sales.created_by_id` predates this migration and means the salesperson who
   * raised the sale (FR-02.8, and the "created by" filter in FR-00.5) — not an
   * audit stamp. The migration had to leave it exactly as it was.
   */
  it('keeps sales.created_by_id as its original foreign key', async () => {
    const rows = await query<{ conname: string; refs: string }>(
      `SELECT conname, confrelid::regclass::text AS refs
         FROM pg_constraint
        WHERE conrelid = 'sales'::regclass AND contype = 'f'
          AND conkey = ARRAY[(SELECT attnum FROM pg_attribute
                               WHERE attrelid = 'sales'::regclass
                                 AND attname = 'created_by_id')]`,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].refs).toBe('users');
  });

  it('deleting a user clears attribution rather than destroying the record', async () => {
    const shop = await query<{ id: string }>(
      `INSERT INTO shops (name, created_by_id) VALUES ('Audit Shop', 1) RETURNING id::text`,
    );
    await query(`DELETE FROM users WHERE id = 1`);

    const rows = await query<{ created_by_id: string | null }>(
      `SELECT created_by_id FROM shops WHERE id = $1`,
      [shop[0].id],
    );
    // ON DELETE SET NULL — the shop survives its author (cf. §2's delete table).
    expect(rows[0].created_by_id).toBeNull();
  });
});
