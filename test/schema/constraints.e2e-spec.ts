import {
  closePool,
  expectAccepted,
  expectRejectedBy,
  loadFixture,
  migrateTestDatabase,
  query,
} from './harness';

const ITEM_TYPE = (code: string) =>
  `(SELECT id FROM item_types WHERE code='${code}')`;
const STATUS = (scope: string, code: string) =>
  `(SELECT id FROM statuses WHERE scope='${scope}' AND code='${code}')`;
const METHOD = (scope: string, code: string) =>
  `(SELECT id FROM payment_methods WHERE scope='${scope}' AND code='${code}')`;

jest.setTimeout(60_000);

beforeAll(async () => {
  await migrateTestDatabase();
  await loadFixture();
});

afterAll(async () => {
  await closePool();
});

describe('shop isolation (FR-11)', () => {
  it('BR-50 refuses a sale line drawing on another shop’s stock', () =>
    expectRejectedBy(
      'fk_saleitem_inventory_shop',
      `INSERT INTO sale_items (sale_id, shop_id, item_type_id, item_type_code, inventory_item_id, quantity, unit_price)
       VALUES (1, 1, ${ITEM_TYPE('inventory')}, 'inventory', 2, 1, 50)`,
    ));

  it('BR-50 allows a sale line drawing on its own shop’s stock', () =>
    expectAccepted(
      `INSERT INTO sale_items (sale_id, shop_id, item_type_id, item_type_code, inventory_item_id, quantity, unit_price)
       VALUES (1, 1, ${ITEM_TYPE('inventory')}, 'inventory', 1, 2, 50)`,
    ));

  it('BR-53 refuses a sale whose customer belongs to another shop', () =>
    expectRejectedBy(
      'fk_sale_customer_shop',
      `INSERT INTO sales (sale_number, shop_id, customer_id, status_id, status_code)
       VALUES ('X-1', 1, 2, ${STATUS('sale', 'draft')}, 'draft')`,
    ));

  it('BR-51 refuses a duplicate product code within one shop', () =>
    expectRejectedBy(
      'uq_inventory_shop_part_code',
      `INSERT INTO inventory_items (shop_id, part_code, part_name, unit_id, quantity, unit_price)
       VALUES (1, 'CLP-001', 'Clip dup', (SELECT id FROM units WHERE code='pcs'), 1, 1)`,
    ));

  it('BR-51 allows the same product code in a different shop', async () => {
    const rows = await query<{ count: string }>(
      `SELECT count(*)::text AS count FROM inventory_items WHERE part_code='CLP-001'`,
    );
    expect(rows[0].count).toBe('2');
  });

  it('BR-47 refuses a shop name differing only by case', () =>
    expectRejectedBy(
      'uq_shops_name_ci',
      `INSERT INTO shops (name) VALUES ('gulshan branch')`,
    ));

  it('BR-48 refuses deleting a shop that holds customers', () =>
    expectRejectedBy(
      'customers_shop_id_fkey',
      `DELETE FROM shops WHERE id = 2`,
    ));
});

describe('sale line shape (BR-04)', () => {
  it('refuses a machine line carrying an inventory item', () =>
    expectRejectedBy(
      'saleitem_kind_consistent',
      `INSERT INTO sale_items (sale_id, shop_id, item_type_id, item_type_code, inventory_item_id, description, quantity, unit_price)
       VALUES (1, 1, ${ITEM_TYPE('non_inventory')}, 'non_inventory', 1, 'Lathe', 1, 900)`,
    ));

  it('refuses a stocked line with no inventory item', () =>
    expectRejectedBy(
      'saleitem_kind_consistent',
      `INSERT INTO sale_items (sale_id, shop_id, item_type_id, item_type_code, quantity, unit_price)
       VALUES (1, 1, ${ITEM_TYPE('inventory')}, 'inventory', 1, 50)`,
    ));

  it('refuses a machine line with a blank description', () =>
    expectRejectedBy(
      'saleitem_kind_consistent',
      `INSERT INTO sale_items (sale_id, shop_id, item_type_id, item_type_code, description, quantity, unit_price)
       VALUES (1, 1, ${ITEM_TYPE('non_inventory')}, 'non_inventory', '   ', 1, 900)`,
    ));

  it('accepts a well-formed machine line', () =>
    expectAccepted(
      `INSERT INTO sale_items (sale_id, shop_id, item_type_id, item_type_code, description, quantity, unit_price)
       VALUES (1, 1, ${ITEM_TYPE('non_inventory')}, 'non_inventory', 'Lathe machine', 1, 900)`,
    ));
});

describe('denormalised codes cannot drift (BR-63, BR-64, BR-65)', () => {
  // A draft status_id paired with the 'cancelled' code: neither is 'finalized',
  // so sale_finalized_has_timestamp is satisfied and the composite foreign key
  // is what has to fire.
  it('BR-63 refuses a sale status_code disagreeing with its status_id', () =>
    expectRejectedBy(
      'fk_sales_status',
      `INSERT INTO sales (sale_number, shop_id, customer_id, status_id, status_code)
       VALUES ('X-2', 1, 1, ${STATUS('sale', 'draft')}, 'cancelled')`,
    ));

  it('BR-64 refuses a supplier method_code disagreeing with its method id', () =>
    expectRejectedBy(
      'fk_supplierpayment_method',
      `INSERT INTO supplier_purchase_payments (purchase_id, receipt_number, amount, payment_date, payment_method_id, method_code, reference_number)
       VALUES (1, 'SPAY-X3', 100, '2026-08-26', ${METHOD('supplier', 'lc')}, 'cash', 'R1')`,
    ));

  it('FR-12.8.4 refuses a third item type at the point of use', () =>
    expectRejectedBy(
      'saleitem_kind_consistent',
      `WITH t AS (INSERT INTO item_types (code, label) VALUES ('service','Service') RETURNING id)
       INSERT INTO sale_items (sale_id, shop_id, item_type_id, item_type_code, description, quantity, unit_price)
       SELECT 1, 1, t.id, 'service', 'Fitting', 1, 100 FROM t`,
    ));

  it('FR-12.11.2 refuses a fourth claim status at the point of use', () =>
    expectRejectedBy(
      'billclaim_review_consistent',
      `WITH s AS (INSERT INTO statuses (scope, code, label) VALUES ('claim','on_hold','On Hold') RETURNING id)
       INSERT INTO bill_claims (user_id, amount, description, bill_date, status_id, status_code)
       SELECT 1, 100, 'Taxi', '2026-08-01', s.id, 'on_hold' FROM s`,
    ));
});

describe('scoped reference data (BR-58, BR-62)', () => {
  it('BR-58 refuses a customer set to the staff-only On Leave status', () =>
    expectRejectedBy(
      'fk_customers_status',
      `INSERT INTO customers (customer_id, shop_id, name, phone, status_id)
       VALUES ('FE-X', 1, 'Bad', '017', ${STATUS('user', 'on_leave')})`,
    ));

  it('BR-58 refuses a staff account taking a customer-scoped status', () =>
    expectRejectedBy(
      'fk_users_status',
      `UPDATE users SET status_id = ${STATUS('customer', 'active')} WHERE id = 1`,
    ));

  // The sale needs a value first: sale_not_overpaid is a CHECK maintained by an
  // AFTER trigger and so fires immediately, whereas fk_sale_payments_method is
  // DEFERRABLE. Against a zero-value sale the overpayment rule would win the
  // race and the test would assert the wrong thing.
  it('BR-62 refuses the supplier-only LC method on a customer receipt', () =>
    expectRejectedBy(
      'fk_sale_payments_method',
      `INSERT INTO sale_payments (sale_id, receipt_number, amount, payment_date, payment_method_id)
       VALUES (1, 'RCPT-X', 10, '2026-08-26', ${METHOD('supplier', 'lc')})`,
      [
        `INSERT INTO sale_items (sale_id, shop_id, item_type_id, item_type_code, inventory_item_id, quantity, unit_price)
         VALUES (1, 1, ${ITEM_TYPE('inventory')}, 'inventory', 1, 2, 50)`,
      ],
    ));

  it('BR-62 accepts a customer-scoped method on a customer receipt', () =>
    expectAccepted(
      `INSERT INTO sale_payments (sale_id, receipt_number, amount, payment_date, payment_method_id)
       VALUES (1, 'RCPT-Y', 10, '2026-08-26', ${METHOD('customer', 'cash')})`,
      [
        `INSERT INTO sale_items (sale_id, shop_id, item_type_id, item_type_code, inventory_item_id, quantity, unit_price)
         VALUES (1, 1, ${ITEM_TYPE('inventory')}, 'inventory', 1, 2, 50)`,
      ],
    ));
});

describe('finalisation (BR-07)', () => {
  it('refuses a finalised sale with no finalisation time', () =>
    expectRejectedBy(
      'sale_finalized_has_timestamp',
      `UPDATE sales SET status_id = ${STATUS('sale', 'finalized')}, status_code = 'finalized' WHERE id = 1`,
    ));

  // The other half of the biconditional: this is what stops the "reverted to
  // draft" path leaving a stale finalized_at that would corrupt BR-16's FIFO.
  it('refuses a draft sale carrying a finalisation time', () =>
    expectRejectedBy(
      'sale_finalized_has_timestamp',
      `UPDATE sales SET finalized_at = now() WHERE id = 1`,
    ));
});

describe('stock (BR-23, BR-27)', () => {
  it('BR-23 refuses negative stock', () =>
    expectRejectedBy(
      'inventoryitem_quantity_non_negative',
      `UPDATE inventory_items SET quantity = -1 WHERE id = 1`,
    ));

  it('BR-23 refuses a negative box count', () =>
    expectRejectedBy(
      'inventoryitem_boxes_non_negative',
      `UPDATE inventory_items SET box_count = -1 WHERE id = 1`,
    ));

  it('BR-27 refuses deleting a product that has been sold', async () => {
    await query(
      `INSERT INTO sale_items (sale_id, shop_id, item_type_id, item_type_code, inventory_item_id, quantity, unit_price)
       VALUES (1, 1, ${ITEM_TYPE('inventory')}, 'inventory', 1, 2, 50)`,
    );
    await expectRejectedBy(
      'sale_items_inventory_item_id_fkey',
      `DELETE FROM inventory_items WHERE id = 1`,
    );
    await query(`DELETE FROM sale_items WHERE sale_id = 1`);
  });
});

describe('supplier payments (BR-29, BR-30)', () => {
  it('BR-29 refuses an LC payment with no reference number', () =>
    expectRejectedBy(
      'supplierpayment_reference_required',
      `INSERT INTO supplier_purchase_payments (purchase_id, receipt_number, amount, payment_date, payment_method_id, method_code)
       VALUES (1, 'SPAY-X1', 100, '2026-08-26', ${METHOD('supplier', 'lc')}, 'lc')`,
    ));

  it('BR-29 allows a cash payment with no reference number', () =>
    expectAccepted(
      `INSERT INTO supplier_purchase_payments (purchase_id, receipt_number, amount, payment_date, payment_method_id, method_code)
       VALUES (1, 'SPAY-X2', 100, '2026-08-26', ${METHOD('supplier', 'cash')}, 'cash')`,
    ));

  it('BR-30 refuses a payment exceeding the purchase price', () =>
    expectRejectedBy(
      'purchase_not_overpaid',
      `INSERT INTO supplier_purchase_payments (purchase_id, receipt_number, amount, payment_date, payment_method_id, method_code)
       VALUES (1, 'SPAY-X4', 5000, '2026-08-26', ${METHOD('supplier', 'cash')}, 'cash')`,
    ));
});

describe('bill claims (BR-35, BR-36, BR-37)', () => {
  it('BR-36 refuses an approved claim with no expense', () =>
    expectRejectedBy(
      'billclaim_review_consistent',
      `INSERT INTO bill_claims (user_id, amount, description, bill_date, status_id, status_code, approval_date)
       VALUES (1, 100, 'Taxi', '2026-08-01', ${STATUS('claim', 'approved')}, 'approved', '2026-08-02')`,
    ));

  it('BR-35 refuses a pending claim that already names a reviewer', () =>
    expectRejectedBy(
      'billclaim_review_consistent',
      `INSERT INTO bill_claims (user_id, amount, description, bill_date, status_id, status_code, approved_by_id)
       VALUES (1, 100, 'Taxi', '2026-08-01', ${STATUS('claim', 'pending')}, 'pending', 1)`,
    ));
});

describe('ledger (BR-39)', () => {
  const post = (reference: string, amount: number) =>
    `INSERT INTO ledger_entries (entry_type_id, source_id, reference, amount)
     VALUES ((SELECT id FROM ledger_entry_types WHERE code='credit'),
             (SELECT id FROM ledger_sources WHERE code='sale_payment'), '${reference}', ${amount})`;

  it('refuses the same source and reference twice', async () => {
    await query(post('RCPT-DUP', 100));
    await expectRejectedBy('uq_ledger_source_reference', post('RCPT-DUP', 100));
    await query(`DELETE FROM ledger_entries WHERE reference = 'RCPT-DUP'`);
  });

  // The index is partial (WHERE reference <> '') precisely so that rows with no
  // reference do not collide with each other.
  it('allows many entries with a blank reference', () =>
    expectAccepted(
      `INSERT INTO ledger_entries (entry_type_id, source_id, reference, amount)
       SELECT (SELECT id FROM ledger_entry_types WHERE code='debit'),
              (SELECT id FROM ledger_sources WHERE code='other'), '', v
         FROM (VALUES (5), (7)) AS t(v)`,
    ));
});

describe('reference data (BR-59, BR-60)', () => {
  it('BR-60 refuses deleting a unit that is in use', () =>
    expectRejectedBy(
      'inventory_items_unit_id_fkey',
      `DELETE FROM units WHERE code = 'pcs'`,
    ));

  it('refuses a code containing punctuation or spaces', () =>
    expectRejectedBy(
      'units_code_shape',
      `INSERT INTO units (code, label) VALUES ('sq ft','Square Feet')`,
    ));
});
