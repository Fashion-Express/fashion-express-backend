import { Pool, type PoolClient } from 'pg';
import { DataSource } from 'typeorm';
import { buildDataSourceOptions } from '../../src/config/data-source';

/**
 * Most of this system's rules live in the database, not in the service layer.
 * Mocking a repository would verify nothing about them — so this suite runs
 * against a real PostgreSQL and asserts that violating writes are *rejected*.
 *
 * It is a port of DB_DESIGN.MD §20's verification record, where the complete
 * DDL was executed against a live instance and each business-rule constraint
 * tested with data designed to break it.
 */

let pool: Pool;

export async function migrateTestDatabase(): Promise<void> {
  const ds = new DataSource(buildDataSourceOptions());
  await ds.initialize();
  await ds.runMigrations();
  await ds.destroy();
}

export function getPool(): Pool {
  if (!pool) {
    const options = buildDataSourceOptions() as { url: string };
    pool = new Pool({ connectionString: options.url, max: 4 });
  }
  return pool;
}

export async function closePool(): Promise<void> {
  if (pool) await pool.end();
}

export interface PgError extends Error {
  constraint?: string;
  code?: string;
  // DETAIL: names the columns and the table on a referential failure, which is
  // what the message derivation reads.
  detail?: string;
  column?: string;
}

/**
 * Run `sql` inside a transaction that is always rolled back, so tests never
 * see each other's writes.
 *
 * `SET CONSTRAINTS ALL IMMEDIATE` is essential: the schema declares most of its
 * foreign keys DEFERRABLE INITIALLY DEFERRED, so without this a violation would
 * surface at COMMIT — after the assertion has already run — and the test would
 * report a false pass.
 */
async function attempt(
  sql: string,
  setup: string[] = [],
): Promise<PgError | undefined> {
  const client: PoolClient = await getPool().connect();
  try {
    await client.query('BEGIN');
    // Preconditions run in the same transaction and are rolled back with it.
    // A failure here is a broken test, not a constraint doing its job, so it
    // is reported separately rather than being mistaken for the expected
    // rejection.
    for (const statement of setup) {
      try {
        await client.query(statement);
      } catch (error) {
        throw new Error(
          `Test precondition failed: ${(error as Error).message}\n  ${statement}`,
        );
      }
    }
    await client.query(sql);
    await client.query('SET CONSTRAINTS ALL IMMEDIATE');
    return undefined;
  } catch (error) {
    if (
      error instanceof Error &&
      error.message.startsWith('Test precondition')
    ) {
      throw error;
    }
    return error as PgError;
  } finally {
    await client.query('ROLLBACK').catch(() => undefined);
    client.release();
  }
}

/**
 * Assert the write is refused **and that the named constraint is what refused
 * it**. The second half matters: without it a test can pass for an unrelated
 * reason — a primary-key collision, say — and quietly stop covering the rule it
 * claims to.
 */
export async function expectRejectedBy(
  constraint: string,
  sql: string,
  setup: string[] = [],
): Promise<void> {
  const error = await attempt(sql, setup);
  if (!error) {
    throw new Error(
      `Expected constraint "${constraint}" to reject the write, but it was accepted.`,
    );
  }
  if (error.constraint !== constraint) {
    throw new Error(
      `Expected constraint "${constraint}" to reject the write, but "${
        error.constraint ?? '(none)'
      }" did instead: ${error.message}`,
    );
  }
}

/**
 * The driver error a write provoked, for tests that assert on more than which
 * constraint fired — the message-derivation suite needs `detail` itself, since
 * the wording PostgreSQL puts there is what the filter parses.
 */
export async function captureError(
  sql: string,
  setup: string[] = [],
): Promise<PgError> {
  const error = await attempt(sql, setup);
  if (!error) {
    throw new Error('Expected the write to be refused, but it was accepted.');
  }
  return error;
}

export async function expectAccepted(
  sql: string,
  setup: string[] = [],
): Promise<void> {
  const error = await attempt(sql, setup);
  if (error) {
    throw new Error(`Expected the write to be accepted, but: ${error.message}`);
  }
}

/** Run arbitrary SQL and return rows, outside any test transaction. */
export async function query<T = Record<string, unknown>>(
  sql: string,
  params: unknown[] = [],
): Promise<T[]> {
  const result = await getPool().query(sql, params);
  return result.rows as T[];
}

/**
 * A minimal trading fixture: two shops, so the shop-isolation rules can be
 * tested across them. Committed once; individual tests roll back their own
 * writes on top of it.
 */
export async function loadFixture(): Promise<void> {
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    /**
     * Clear the trading data without touching the seeded reference lists.
     *
     * `users` and `shops` are deliberately *not* in the TRUNCATE list. Since
     * migration 016 every reference table carries `created_by_id -> users`, so
     * `TRUNCATE users CASCADE` now cascades **into the reference lists** and
     * empties them — statuses, units, user_types and the rest — leaving a
     * database in which nothing can be inserted at all.
     *
     * `DELETE` is used instead because those foreign keys are `ON DELETE SET
     * NULL`: the seeded rows survive and merely lose their attribution. The
     * order matters — users before shops, because `users.shop_id` is RESTRICT.
     *
     * Anything else that clears data wholesale — FR-10.3's cleanup tool
     * especially (BR-41 … BR-44) — has to reckon with the same reach.
     */
    await client.query(`
      TRUNCATE sale_items, sale_payments, customer_payment_allocations,
               customer_payment_batches, sales, stock_histories, inventory_items,
               bill_claims, expenses, ledger_entries,
               supplier_purchase_payments, supplier_purchases, suppliers,
               customers RESTART IDENTITY CASCADE
    `);
    await client.query(`DELETE FROM sessions`);
    await client.query(`DELETE FROM accounts`);
    await client.query(`DELETE FROM login_attempts`);
    await client.query(`DELETE FROM users`);
    await client.query(`DELETE FROM shops`);
    await client.query(
      `INSERT INTO shops (id, name) OVERRIDING SYSTEM VALUE
         VALUES (1,'Gulshan Branch'), (2,'Dhanmondi Branch')`,
    );
    await client.query(
      `INSERT INTO users (id, username, name, user_type_id, status_id, shop_id)
       OVERRIDING SYSTEM VALUE
       SELECT 1, 'rabby', 'Rabby',
              (SELECT id FROM user_types WHERE code='owner'),
              (SELECT id FROM statuses WHERE scope='user' AND code='active'), 1`,
    );
    await client.query(
      `INSERT INTO customers (id, customer_id, shop_id, name, phone, status_id)
       OVERRIDING SYSTEM VALUE
       SELECT 1, 'FE26082026-01', 1, 'Karim Traders', '01700000000',
              (SELECT id FROM statuses WHERE scope='customer' AND code='active')`,
    );
    await client.query(
      `INSERT INTO customers (id, customer_id, shop_id, name, phone, status_id)
       OVERRIDING SYSTEM VALUE
       SELECT 2, 'FE26082026-02', 2, 'Dhanmondi Co', '01700000001',
              (SELECT id FROM statuses WHERE scope='customer' AND code='active')`,
    );
    // The same part_code in both shops is legal under BR-51, and is the setup
    // for the cross-shop tests.
    await client.query(
      `INSERT INTO inventory_items (id, shop_id, part_code, part_name, unit_id, quantity, unit_price, minimum_stock)
       OVERRIDING SYSTEM VALUE
       SELECT 1, 1, 'CLP-001', 'Clip', (SELECT id FROM units WHERE code='pcs'), 100, 50, 10`,
    );
    await client.query(
      `INSERT INTO inventory_items (id, shop_id, part_code, part_name, unit_id, quantity, unit_price, minimum_stock)
       OVERRIDING SYSTEM VALUE
       SELECT 2, 2, 'CLP-001', 'Clip', (SELECT id FROM units WHERE code='pcs'), 5, 55, 10`,
    );
    await client.query(
      `INSERT INTO sales (id, sale_number, shop_id, customer_id, status_id, status_code, created_by_id)
       OVERRIDING SYSTEM VALUE
       SELECT 1, '26-08-2026-FE-0001', 1, 1,
              (SELECT id FROM statuses WHERE scope='sale' AND code='draft'), 'draft', 1`,
    );
    await client.query(
      `INSERT INTO suppliers (id, name, phone) OVERRIDING SYSTEM VALUE
         VALUES (1,'Acme Metals','01800000000')`,
    );
    await client.query(
      `INSERT INTO supplier_purchases (id, supplier_id, product_name, price, purchase_date)
       OVERRIDING SYSTEM VALUE VALUES (1, 1, 'Steel sheet', 1000, '2026-08-01')`,
    );

    /**
     * Advance every identity sequence past the explicit fixture ids. Inserting
     * an explicit value into a GENERATED BY DEFAULT AS IDENTITY column does not
     * move the sequence, so without this the next generated id collides with a
     * fixture row — and tests start passing on primary-key violations instead
     * of the rule under test.
     */
    await client.query(`
      DO $$
      DECLARE r record; seq text; mx bigint;
      BEGIN
        FOR r IN SELECT table_name FROM information_schema.columns
                 WHERE table_schema='public' AND column_name='id' AND is_identity='YES'
        LOOP
          seq := pg_get_serial_sequence('public.'||r.table_name, 'id');
          IF seq IS NOT NULL THEN
            EXECUTE format('SELECT COALESCE(MAX(id),0) FROM %I', r.table_name) INTO mx;
            PERFORM setval(seq, GREATEST(mx, 1));
          END IF;
        END LOOP;
      END $$;
    `);
    /**
     * Advance the RD-01 counters past the fixture's hand-written identifiers.
     *
     * The fixture inserts customers with explicit `customer_id` values, which
     * does not touch `customer_id_sequences` — so the first customer created
     * through the API would draw serial 1 and collide. This is the same hazard
     * as the identity resync above: writing an identifier by hand leaves the
     * generator behind.
     */
    await client.query(
      `UPDATE customer_id_sequences SET last_serial = GREATEST(last_serial,
         (SELECT count(*) FROM customers)) WHERE id = 1`,
    );
    await client.query(
      `UPDATE sale_id_sequences SET sequence_num = GREATEST(sequence_num,
         (SELECT count(*) FROM sales)) WHERE id = 1`,
    );

    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}
