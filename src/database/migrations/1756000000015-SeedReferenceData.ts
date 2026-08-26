import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * RD-02 … RD-15 — seed content for the reference lists, plus the permission
 * catalogue (§10.3 option B) and the two singleton counter rows.
 *
 * NFR-17 requires data backfills to be separated from structural changes so
 * each can be rolled back independently, which is why this is its own migration
 * rather than being folded into 001.
 *
 * Everything here is *seed* content, not a fixed set: labels are freely
 * editable and most lists are extensible. The **codes** are what must not
 * change (BR-59) — several are load-bearing:
 *
 *   `finalized`, `quote`, `draft`, `cancelled`  read by sale rules and indexes
 *   `inventory`, `non_inventory`                read by saleitem_kind_consistent
 *   `pending`, `approved`, `rejected`           read by billclaim_review_consistent
 *   `cash`                                      read by BR-29 (supplier scope)
 *   `active`                                    read by the active-staff figure
 */
export class SeedReferenceData1756000000015 implements MigrationInterface {
  name = 'SeedReferenceData1756000000015';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // ---- RD-14 user types ----------------------------------------------
    // The two privilege columns are what the type confers (BR-56). Finance
    // confers no elevated privilege; it exists to classify staff and to hold
    // permissions.
    await queryRunner.query(`
      INSERT INTO user_types (code, label, description, is_superuser, is_manager, sort_order) VALUES
        ('owner',    'Owner',    'Business owner. Unrestricted access.',        true,  true,  1),
        ('manager',  'Manager',  'Sees all sales, reviews claims, opens reports.', false, true,  2),
        ('finance',  'Finance',  'Payment and ledger work.',                    false, false, 3),
        ('employee', 'Employee', 'General staff. Sees only their own work.',    false, false, 4)
    `);

    // ---- RD-09/RD-10/RD-03/RD-08 statuses, four scopes ------------------
    await queryRunner.query(`
      INSERT INTO statuses (scope, code, label, sort_order) VALUES
        ('user',     'active',    'Active',    1),
        ('user',     'inactive',  'Inactive',  2),
        ('user',     'on_leave',  'On Leave',  3),
        ('customer', 'active',    'Active',    1),
        ('customer', 'inactive',  'Inactive',  2),
        ('sale',     'quote',     'Quotation', 1),
        ('sale',     'draft',     'Draft',     2),
        ('sale',     'finalized', 'Finalised', 3),
        ('sale',     'cancelled', 'Cancelled', 4),
        ('claim',    'pending',   'Pending',   1),
        ('claim',    'approved',  'Approved',  2),
        ('claim',    'rejected',  'Rejected',  3)
    `);

    // ---- RD-05 expense categories --------------------------------------
    await queryRunner.query(`
      INSERT INTO expense_categories (code, label, sort_order) VALUES
        ('salary',      'Salary',      1),
        ('utilities',   'Utilities',   2),
        ('maintenance', 'Maintenance', 3),
        ('transport',   'Transport',   4),
        ('supplies',    'Supplies',    5),
        ('rent',        'Rent',        6),
        ('marketing',   'Marketing',   7),
        ('other',       'Other',       8)
    `);

    // ---- RD-02 units ----------------------------------------------------
    await queryRunner.query(`
      INSERT INTO units (code, label, sort_order) VALUES
        ('pcs', 'Pieces',   1),
        ('box', 'Box',      2),
        ('kg',  'Kilogram', 3),
        ('ltr', 'Litre',    4),
        ('mtr', 'Metre',    5)
    `);

    // ---- RD-07 stock movement types (structural, BR-61) -----------------
    await queryRunner.query(`
      INSERT INTO transaction_types (code, label, direction, sort_order) VALUES
        ('in',         'Stock In',   1, 1),
        ('out',        'Stock Out', -1, 2),
        ('adjustment', 'Adjustment', 0, 3)
    `);

    // ---- FR-12.8.2 sale line item types ---------------------------------
    // 'Machine' is the label; 'non_inventory' is the code the constraint reads.
    await queryRunner.query(`
      INSERT INTO item_types (code, label, sort_order) VALUES
        ('inventory',     'Inventory', 1),
        ('non_inventory', 'Machine',   2)
    `);

    // ---- RD-04 / RD-06 / RD-15 payment methods --------------------------
    // Scopes are independent namespaces, which is what lets the supplier scope
    // keep `check` while the customer scope uses `cheque` (§23.2).
    await queryRunner.query(`
      INSERT INTO payment_methods (scope, code, label, sort_order) VALUES
        ('customer', 'cash',          'Cash',          1),
        ('customer', 'bank_transfer', 'Bank transfer', 2),
        ('customer', 'card',          'Card',          3),
        ('customer', 'cheque',        'Cheque',        4),
        ('customer', 'other',         'Other',         5),
        ('supplier', 'lc',            'LC',            1),
        ('supplier', 'check',         'Cheque',        2),
        ('supplier', 'tt',            'TT',            3),
        ('supplier', 'cash',          'Cash',          4),
        ('supplier', 'bank',          'Bank',          5),
        ('expense',  'cash',          'Cash',          1),
        ('expense',  'bank_transfer', 'Bank transfer', 2),
        ('expense',  'cheque',        'Cheque',        3),
        ('expense',  'card',          'Card',          4),
        ('expense',  'other',         'Other',         5)
    `);

    // ---- RD-11 ledger types and sources (structural, BR-66) -------------
    await queryRunner.query(`
      INSERT INTO ledger_entry_types (code, label, direction, sort_order) VALUES
        ('credit', 'Credit',  1, 1),
        ('debit',  'Debit',  -1, 2)
    `);
    await queryRunner.query(`
      INSERT INTO ledger_sources (code, label, sort_order) VALUES
        ('sale_payment',     'Sale payment',     1),
        ('expense',          'Expense',          2),
        ('supplier_payment', 'Supplier payment', 3),
        ('other',            'Other',            4)
    `);

    // ---- the singleton counter rows (§7.2) ------------------------------
    await queryRunner.query(
      `INSERT INTO customer_id_sequences (id, last_serial) VALUES (1, 0)`,
    );
    await queryRunner.query(
      `INSERT INTO sale_id_sequences (id, sequence_num) VALUES (1, 0)`,
    );

    // ---- §10.3 option B: the permission catalogue -----------------------
    await queryRunner.query(`
      INSERT INTO permissions (codename, label, module) VALUES
        ${PERMISSIONS.map(
          (p) =>
            `('${p.codename}', '${p.label.replace(/'/g, "''")}', '${p.module}')`,
        ).join(',\n        ')}
    `);

    // Grants per user type. Owner is unrestricted by its `is_superuser` flag,
    // but is granted everything explicitly too so the administration screen
    // shows the truth rather than an empty list.
    for (const [typeCode, codenames] of Object.entries(GRANTS)) {
      if (codenames.length === 0) continue;
      await queryRunner.query(
        `INSERT INTO user_type_permissions (user_type_id, permission_id)
           SELECT t.id, p.id
             FROM user_types t, permissions p
            WHERE t.code = $1 AND p.codename = ANY($2)`,
        [typeCode, codenames],
      );
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DELETE FROM user_type_permissions`);
    await queryRunner.query(`DELETE FROM permissions`);
    await queryRunner.query(`DELETE FROM sale_id_sequences`);
    await queryRunner.query(`DELETE FROM customer_id_sequences`);
    await queryRunner.query(`DELETE FROM ledger_sources`);
    await queryRunner.query(`DELETE FROM ledger_entry_types`);
    await queryRunner.query(`DELETE FROM payment_methods`);
    await queryRunner.query(`DELETE FROM item_types`);
    await queryRunner.query(`DELETE FROM transaction_types`);
    await queryRunner.query(`DELETE FROM units`);
    await queryRunner.query(`DELETE FROM expense_categories`);
    await queryRunner.query(`DELETE FROM statuses`);
    await queryRunner.query(`DELETE FROM user_types`);
  }
}

/**
 * The codenames deliberately reuse the legacy names REQUIREMENTS.MD already
 * cites, so every requirement stays traceable to the thing that enforces it
 * (§10.3, final paragraph).
 */
const PERMISSIONS: Array<{ codename: string; label: string; module: string }> =
  [
    // Sales (FR-02)
    { codename: 'add_sale', label: 'Create a sale', module: 'sales' },
    { codename: 'change_sale', label: 'Edit a sale', module: 'sales' },
    { codename: 'delete_sale', label: 'Delete a draft sale', module: 'sales' },
    { codename: 'view_sale', label: 'View sales', module: 'sales' },
    // FR-02.4.3 — its own permission, so the staff who assemble orders need not
    // be the staff who commit them.
    { codename: 'finalize_sale', label: 'Finalise a sale', module: 'sales' },
    {
      codename: 'add_salepayment',
      label: 'Record a sale payment',
      module: 'sales',
    },
    {
      codename: 'change_salepayment',
      label: 'Edit a sale payment',
      module: 'sales',
    },
    {
      codename: 'delete_salepayment',
      label: 'Delete a sale payment',
      module: 'sales',
    },

    // Customers (FR-03)
    { codename: 'add_customer', label: 'Add a customer', module: 'customers' },
    {
      codename: 'change_customer',
      label: 'Edit a customer',
      module: 'customers',
    },
    {
      codename: 'delete_customer',
      label: 'Delete a customer',
      module: 'customers',
    },
    { codename: 'view_customer', label: 'View customers', module: 'customers' },
    {
      codename: 'add_customerpayment',
      label: 'Take a customer payment',
      module: 'customers',
    },

    // Inventory (FR-04)
    {
      codename: 'add_inventoryitem',
      label: 'Add a product',
      module: 'inventory',
    },
    {
      codename: 'change_inventoryitem',
      label: 'Edit a product',
      module: 'inventory',
    },
    {
      codename: 'delete_inventoryitem',
      label: 'Delete a product',
      module: 'inventory',
    },
    {
      codename: 'view_inventoryitem',
      label: 'View inventory',
      module: 'inventory',
    },

    // Suppliers (FR-05)
    { codename: 'add_supplier', label: 'Add a supplier', module: 'suppliers' },
    {
      codename: 'change_supplier',
      label: 'Edit a supplier',
      module: 'suppliers',
    },
    {
      codename: 'delete_supplier',
      label: 'Delete a supplier',
      module: 'suppliers',
    },
    { codename: 'view_supplier', label: 'View suppliers', module: 'suppliers' },
    {
      codename: 'add_supplierpayment',
      label: 'Pay a supplier',
      module: 'suppliers',
    },

    // Expenses (FR-06) — BR-33: anyone with add may create, only managers edit.
    { codename: 'add_expense', label: 'Record an expense', module: 'expenses' },
    {
      codename: 'change_expense',
      label: 'Edit an expense',
      module: 'expenses',
    },
    {
      codename: 'delete_expense',
      label: 'Delete an expense',
      module: 'expenses',
    },
    { codename: 'view_expense', label: 'View expenses', module: 'expenses' },

    // Bill claims (FR-07)
    { codename: 'submit_bill', label: 'Submit a bill claim', module: 'claims' },
    {
      codename: 'view_my_bills',
      label: 'View my bill claims',
      module: 'claims',
    },
    { codename: 'review_bills', label: 'Review bill claims', module: 'claims' },

    // Shops (FR-11.2)
    { codename: 'add_shop', label: 'Add a shop', module: 'shops' },
    { codename: 'change_shop', label: 'Edit a shop', module: 'shops' },
    { codename: 'delete_shop', label: 'Delete a shop', module: 'shops' },
    { codename: 'view_shop', label: 'View shops', module: 'shops' },

    // Staff accounts (FR-00.6)
    { codename: 'add_user', label: 'Add a staff account', module: 'users' },
    { codename: 'change_user', label: 'Edit a staff account', module: 'users' },
    {
      codename: 'delete_user',
      label: 'Delete a staff account',
      module: 'users',
    },
    { codename: 'view_user', label: 'View staff accounts', module: 'users' },

    // Reference data (FR-12.5.1)
    {
      codename: 'manage_referencedata',
      label: 'Manage reference lists',
      module: 'reference',
    },

    // Ledger and reports (FR-08, FR-09) — manager-only by FR-09.5.
    { codename: 'view_ledger', label: 'View the ledger', module: 'reports' },
    {
      codename: 'rebuild_ledger',
      label: 'Rebuild the ledger',
      module: 'reports',
    },
    { codename: 'export_data', label: 'Export data', module: 'reports' },

    // Administration (FR-10)
    {
      codename: 'change_businesssettings',
      label: 'Configure business details',
      module: 'admin',
    },
    {
      codename: 'clean_data',
      label: 'Run the data cleanup tool',
      module: 'admin',
    },

    // Menu and action permissions (FR-00.2 mechanism 2) — these gate navigation
    // entries that have no record of their own.
    {
      codename: 'view_customers_menu',
      label: 'Open the customers menu',
      module: 'menu',
    },
    {
      codename: 'view_inventory_menu',
      label: 'Open the inventory menu',
      module: 'menu',
    },
    {
      codename: 'view_expenses_menu',
      label: 'Open the expenses menu',
      module: 'menu',
    },
    {
      codename: 'view_reports_menu',
      label: 'Open the reports menu',
      module: 'menu',
    },
    {
      codename: 'view_sales_menu',
      label: 'Open the sales menu',
      module: 'menu',
    },
    {
      codename: 'view_suppliers_menu',
      label: 'Open the suppliers menu',
      module: 'menu',
    },
    {
      codename: 'view_shops_menu',
      label: 'Open the shops menu',
      module: 'menu',
    },
  ];

const ALL = PERMISSIONS.map((p) => p.codename);

/**
 * Manager gets everything except the destructive administration tools
 * (BR-41 restricts the cleanup tool to unrestricted accounts) and staff-account
 * deletion. Finance gets money work plus read access. Employee gets the
 * narrowest set: create sales, submit claims, and see their own work — BR-01
 * then confines "their own work" at the query level.
 */
const GRANTS: Record<string, string[]> = {
  owner: ALL,
  manager: ALL.filter(
    (c) => !['clean_data', 'delete_user', 'delete_shop'].includes(c),
  ),
  finance: [
    'view_sale',
    'view_customer',
    'add_salepayment',
    'change_salepayment',
    'delete_salepayment',
    'add_customerpayment',
    'add_supplierpayment',
    'view_supplier',
    'add_expense',
    'view_expense',
    'view_ledger',
    'export_data',
    'submit_bill',
    'view_my_bills',
    'view_sales_menu',
    'view_customers_menu',
    'view_expenses_menu',
    'view_suppliers_menu',
    'view_reports_menu',
  ],
  employee: [
    'add_sale',
    'change_sale',
    'delete_sale',
    'view_sale',
    'add_customer',
    'view_customer',
    'view_inventoryitem',
    'add_salepayment',
    'submit_bill',
    'view_my_bills',
    'view_sales_menu',
    'view_customers_menu',
    'view_inventory_menu',
  ],
};
