import {
  closePool,
  expectRejectedBy,
  loadFixture,
  migrateTestDatabase,
  query,
} from './harness';

/**
 * DB_DESIGN.MD §11 — the derived columns.
 *
 * These are the tests that matter most for BR-09 and BR-30, because the
 * overpayment constraints are only enforceable *because* the aggregate is
 * materialised. If the triggers stop firing, the CHECK silently stops
 * protecting anything.
 */

const CASH = `(SELECT id FROM payment_methods WHERE scope='customer' AND code='cash')`;
const ITEM = (code: string) =>
  `(SELECT id FROM item_types WHERE code='${code}')`;

jest.setTimeout(60_000);

beforeAll(async () => {
  await migrateTestDatabase();
});

beforeEach(async () => {
  await loadFixture();
  // Sale 1: one stocked line at 2 x 50, one machine line at 1 x 900 = 1000.
  await query(
    `INSERT INTO sale_items (sale_id, shop_id, item_type_id, item_type_code, inventory_item_id, quantity, unit_price)
     VALUES (1, 1, ${ITEM('inventory')}, 'inventory', 1, 2, 50)`,
  );
  await query(
    `INSERT INTO sale_items (sale_id, shop_id, item_type_id, item_type_code, description, quantity, unit_price)
     VALUES (1, 1, ${ITEM('non_inventory')}, 'non_inventory', 'Lathe machine', 1, 900)`,
  );
});

afterAll(async () => {
  await closePool();
});

async function sale(): Promise<{ total_amount: string; amount_paid: string }> {
  const rows = await query<{ total_amount: string; amount_paid: string }>(
    `SELECT total_amount, amount_paid FROM sales WHERE id = 1`,
  );
  return rows[0];
}

const pay = (receipt: string, amount: number) =>
  `INSERT INTO sale_payments (sale_id, receipt_number, amount, payment_date, payment_method_id)
   VALUES (1, '${receipt}', ${amount}, '2026-08-26', ${CASH})`;

describe('generated column and sale rollup', () => {
  it('computes line_total in the database, not the application', async () => {
    const lines = await query<{ line_total: string }>(
      `SELECT line_total FROM sale_items WHERE sale_id = 1 ORDER BY id`,
    );
    expect(lines.map((l) => l.line_total)).toEqual(['100.00', '900.00']);
  });

  it('rolls line totals up into the sale', async () => {
    expect((await sale()).total_amount).toBe('1000.00');
  });

  it('recomputes the total when a line is removed', async () => {
    await query(
      `DELETE FROM sale_items WHERE sale_id = 1 AND item_type_code = 'non_inventory'`,
    );
    expect((await sale()).total_amount).toBe('100.00');
  });
});

describe('payments roll up and BR-09 holds', () => {
  it('tracks amount_paid as payments are added', async () => {
    await query(pay('RCPT-A', 400));
    expect((await sale()).amount_paid).toBe('400.00');
  });

  it('refuses a payment taking the total past the sale value', async () => {
    await query(pay('RCPT-A', 400));
    await expectRejectedBy('sale_not_overpaid', pay('RCPT-B', 700));
  });

  it('allows a payment settling the exact balance', async () => {
    await query(pay('RCPT-A', 400));
    await query(pay('RCPT-C', 600));
    expect((await sale()).amount_paid).toBe('1000.00');
  });

  // BR-40: the ledger and the rollup must both follow payment edits.
  it('follows an edited payment', async () => {
    await query(pay('RCPT-A', 400));
    await query(
      `UPDATE sale_payments SET amount = 250 WHERE receipt_number = 'RCPT-A'`,
    );
    expect((await sale()).amount_paid).toBe('250.00');
  });

  it('follows a deleted payment', async () => {
    await query(pay('RCPT-A', 400));
    await query(`DELETE FROM sale_payments WHERE receipt_number = 'RCPT-A'`);
    expect((await sale()).amount_paid).toBe('0.00');
  });
});

/**
 * FR-02.6.2 in constraint form, and a rule the service layer has to respect.
 *
 * `sale_not_overpaid` is a plain CHECK maintained by an AFTER trigger, so it is
 * evaluated per statement rather than deferred to COMMIT. Shrinking a sale
 * below what has already been paid against it is therefore refused *at the
 * statement that removes the line* — which means the payments must be removed
 * first, in the same transaction. FR-02.6.2 requires exactly that ("any
 * payments recorded against it are deleted so no orphaned overpayment
 * remains"); this test pins the ordering the implementation has to use.
 */
describe('FR-02.6.2 removing a line that would strand a payment', () => {
  it('refuses the removal while the payment still stands', async () => {
    await query(pay('RCPT-A', 250));
    await expectRejectedBy(
      'sale_not_overpaid',
      `DELETE FROM sale_items WHERE sale_id = 1 AND item_type_code = 'non_inventory'`,
    );
  });

  it('accepts it once the payments are removed first', async () => {
    await query(pay('RCPT-A', 250));
    await query(`DELETE FROM sale_payments WHERE sale_id = 1`);
    await query(
      `DELETE FROM sale_items WHERE sale_id = 1 AND item_type_code = 'non_inventory'`,
    );
    const s = await sale();
    expect(s.total_amount).toBe('100.00');
    expect(s.amount_paid).toBe('0.00');
  });
});

describe('BR-28 supplier purchase paid_amount is derived', () => {
  it('tracks payments against the purchase', async () => {
    await query(
      `INSERT INTO supplier_purchase_payments (purchase_id, receipt_number, amount, payment_date, payment_method_id, method_code)
       VALUES (1, 'SPAY-1', 100, '2026-08-26',
               (SELECT id FROM payment_methods WHERE scope='supplier' AND code='cash'), 'cash')`,
    );
    const rows = await query<{ paid_amount: string }>(
      `SELECT paid_amount FROM supplier_purchases WHERE id = 1`,
    );
    expect(rows[0].paid_amount).toBe('100.00');
  });
});

/**
 * FR-12.12.2 — the running balance is arithmetic over `direction`, not a
 * comparison against the literal 'credit'. This is the reference form; any code
 * still summing two filtered subqueries is reading a column that no longer
 * exists.
 */
describe('FR-12.12.2 the ledger balance reads direction', () => {
  it('sums amount * direction', async () => {
    await query(
      `INSERT INTO ledger_entries (entry_type_id, source_id, reference, amount)
       VALUES ((SELECT id FROM ledger_entry_types WHERE code='credit'),
               (SELECT id FROM ledger_sources WHERE code='sale_payment'), 'R1', 500),
              ((SELECT id FROM ledger_entry_types WHERE code='debit'),
               (SELECT id FROM ledger_sources WHERE code='expense'), 'E1', 200)`,
    );
    const rows = await query<{ balance: string }>(
      `SELECT SUM(e.amount * t.direction) AS balance
         FROM ledger_entries e JOIN ledger_entry_types t ON t.id = e.entry_type_id`,
    );
    expect(rows[0].balance).toBe('300.00');
  });
});
