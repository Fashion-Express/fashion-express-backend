/**
 * Constraint name -> the message a user should see.
 *
 * DB_DESIGN.MD §16 is explicit about the division of labour: the database
 * constraints exist for *correctness* and the application's own checks and row
 * locks exist for *user experience*. A constraint firing therefore means either
 * a race the application lost or a code path that skipped its check — both are
 * real, and both should produce a sentence rather than a driver stack trace.
 *
 * Every entry names the business rule it enforces so the message can be traced
 * back to REQUIREMENTS.MD.
 */
export const CONSTRAINT_MESSAGES: Record<string, string> = {
  // ---- Sales (§6) ----
  sale_not_overpaid: 'Total payments would exceed the value of this sale.', // BR-09
  salepayment_amount_positive: 'A payment must be for more than zero.', // BR-10
  sale_finalized_has_timestamp:
    'A finalised sale must record when it was finalised, and only a finalised sale may.', // BR-07
  sale_totals_non_negative: 'Sale totals cannot be negative.',
  saleitem_kind_consistent:
    'A stocked line must reference an inventory item and a machine line must carry a description — never both, never neither.', // BR-04
  saleitem_quantity_positive:
    'Each line must have a quantity greater than zero.', // BR-05
  saleitem_boxes_non_negative: 'Box count cannot be negative.',
  saleitem_price_non_negative: 'Unit price cannot be negative.',
  fk_saleitem_sale_shop:
    'This line does not belong to the same shop as its sale.', // BR-50
  fk_saleitem_inventory_shop:
    'A sale can only draw on stock held by its own shop.', // BR-50
  fk_sale_customer_shop:
    'The customer must belong to the same shop as the sale.', // BR-53
  fk_sales_status: 'That is not a valid sale status.', // BR-58, BR-63
  sales_status_scope_pinned: 'That status does not apply to sales.', // BR-58
  fk_saleitem_item_type: 'That is not a valid line item type.', // BR-63

  // ---- Inventory (§5) ----
  inventoryitem_quantity_non_negative:
    'Stock cannot go negative — there is not enough on hand.', // BR-23, BR-06
  inventoryitem_boxes_non_negative:
    'Box count cannot go negative — there are not enough boxes on hand.', // BR-23
  inventoryitem_minimum_non_negative: 'Minimum stock level cannot be negative.', // BR-23
  inventoryitem_prices_non_negative: 'Prices cannot be negative.',
  uq_inventory_shop_part_code:
    'This shop already stocks a product with that code.', // BR-51
  stockhistory_quantities_non_negative:
    'A stock movement cannot record a negative quantity.',

  // ---- Shops (§4) ----
  uq_shops_name_ci: 'A shop with that name already exists.', // BR-47
  shop_name_not_blank: 'A shop must have a name.',

  // ---- Customers (§4) ----
  customers_customer_id_key: 'That customer ID is already in use.', // BR-45
  customer_name_not_blank: 'A customer must have a name.',
  fk_customers_status: 'That is not a valid customer status.', // BR-58
  customers_status_scope_pinned: 'That status does not apply to customers.', // BR-58

  // ---- Users (§3) ----
  users_username_key: 'That username is already taken.',
  uq_users_email_ci: 'That email address is already registered.',
  users_employee_id_key: 'That employee ID is already in use.', // BR-45
  users_salary_non_negative: 'Salary cannot be negative.',
  fk_users_status: 'That is not a valid staff status.', // BR-58
  users_status_scope_pinned: 'That status does not apply to staff accounts.', // BR-58

  // ---- Suppliers (§8) ----
  purchase_not_overpaid:
    'Total payments would exceed the value of this purchase.', // BR-30, BR-32
  purchase_price_non_negative: 'Purchase price cannot be negative.',
  purchase_paid_non_negative: 'Paid amount cannot be negative.',
  supplierpayment_reference_required:
    'A reference number is required for LC, cheque, TT, and bank payments.', // BR-29
  supplier_name_not_blank: 'A supplier must have a name.',
  fk_supplierpayment_method: 'That is not a valid supplier payment method.', // BR-62, BR-64

  // ---- Expenses (§9) ----
  fk_expenses_method: 'That is not a valid expense payment method.', // BR-62, BR-64

  // ---- Payments (§6) ----
  sale_payments_receipt_number_key:
    'That receipt number has already been issued.', // BR-45
  sale_payments_scope_pinned:
    'That payment method cannot be used on a customer receipt.', // BR-62
  fk_sale_payments_method: 'That is not a valid customer payment method.', // BR-62
  batch_scope_pinned:
    'That payment method cannot be used on a customer payment.', // BR-62
  fk_batch_method: 'That is not a valid customer payment method.', // BR-62
  batch_amount_positive: 'A payment must be for more than zero.',
  allocation_amount_positive: 'An allocation must be for more than zero.',
  customer_payment_allocations_sale_payment_id_key:
    'That payment has already been allocated to a batch.', // BR-18

  // ---- Bill claims (§9) ----
  billclaim_review_consistent:
    'A claim’s status, review details, and expense do not agree.', // BR-35/36/37
  uq_billclaim_expense: 'That expense is already linked to another claim.', // BR-36
  fk_billclaims_status: 'That is not a valid claim status.', // BR-58, BR-65
  billclaims_status_scope_pinned: 'That status does not apply to bill claims.', // BR-58

  // ---- Ledger (§10) ----
  uq_ledger_source_reference:
    'That payment has already been posted to the ledger.', // BR-39
  ledger_amount_non_negative: 'A ledger amount cannot be negative.',

  // ---- Reference data (§23) ----
  uq_user_types_code: 'That user type code is already in use.',
  uq_user_types_label_ci: 'A user type with that name already exists.',
  uq_job_positions_name_ci: 'That job position already exists.',
  uq_departments_name_ci: 'That department already exists.',
  uq_categories_name_ci: 'That category already exists.',
  uq_expense_categories_code: 'That expense category code is already in use.',
  uq_expense_categories_label_ci: 'That expense category already exists.',
  uq_units_code: 'That unit code is already in use.',
  uq_units_label_ci: 'That unit already exists.',
  uq_transaction_types_code: 'That movement type code is already in use.',
  uq_transaction_types_label_ci: 'That movement type already exists.',
  uq_item_types_code: 'That item type code is already in use.',
  uq_payment_methods_scope_code:
    'That payment method already exists in this scope.',
  uq_ledger_entry_types_code: 'That ledger entry type already exists.',
  uq_ledger_sources_code: 'That ledger source already exists.',
  uq_statuses_scope_code: 'That status already exists in this scope.',
  uq_permissions_codename: 'That permission already exists.',
};

/**
 * Table name -> what a person calls the thing in it.
 *
 * There are 106 foreign keys in this schema and most of them are the
 * `created_by_id` / `updated_by_id` audit pair, so naming every constraint by
 * hand would be a hundred lines that mostly say the same thing. Instead the two
 * foreign-key messages below are *built* from the table PostgreSQL names in its
 * error, and this map is the only part that needs a human.
 *
 * Add a row here when a table is added. A table that is missing degrades to the
 * generic sentence rather than leaking `inventory_items` at a user.
 */
export const ENTITY_LABELS: Record<string, { one: string; many: string }> = {
  accounts: { one: 'login credential', many: 'login credentials' },
  bill_claims: { one: 'claim', many: 'claims' },
  business_settings: { one: 'business setting', many: 'business settings' },
  categories: { one: 'category', many: 'categories' },
  customer_payment_allocations: {
    one: 'payment allocation',
    many: 'payment allocations',
  },
  customer_payment_batches: {
    one: 'customer payment',
    many: 'customer payments',
  },
  customers: { one: 'customer', many: 'customers' },
  departments: { one: 'department', many: 'departments' },
  expense_categories: { one: 'expense category', many: 'expense categories' },
  expenses: { one: 'expense', many: 'expenses' },
  inventory_items: { one: 'product', many: 'products' },
  item_types: { one: 'item type', many: 'item types' },
  job_positions: { one: 'job position', many: 'job positions' },
  ledger_entries: { one: 'ledger entry', many: 'ledger entries' },
  ledger_entry_types: { one: 'ledger entry type', many: 'ledger entry types' },
  ledger_sources: { one: 'ledger source', many: 'ledger sources' },
  payment_methods: { one: 'payment method', many: 'payment methods' },
  permissions: { one: 'permission', many: 'permissions' },
  sale_items: { one: 'sale line', many: 'sale lines' },
  sale_payments: { one: 'payment', many: 'payments' },
  sales: { one: 'sale', many: 'sales' },
  sessions: { one: 'session', many: 'sessions' },
  shops: { one: 'shop', many: 'shops' },
  statuses: { one: 'status', many: 'statuses' },
  stock_histories: { one: 'stock movement', many: 'stock movements' },
  supplier_purchase_payments: {
    one: 'supplier payment',
    many: 'supplier payments',
  },
  supplier_purchases: { one: 'purchase', many: 'purchases' },
  suppliers: { one: 'supplier', many: 'suppliers' },
  transaction_types: {
    one: 'stock movement type',
    many: 'stock movement types',
  },
  units: { one: 'unit', many: 'units' },
  user_type_permissions: { one: 'permission grant', many: 'permission grants' },
  user_types: { one: 'user type', many: 'user types' },
  users: { one: 'staff account', many: 'staff accounts' },
};

/** `shop_id` -> `shopId`, so the message names the field the client sent. */
function camelCase(column: string): string {
  return column.replace(/_([a-z])/g, (_, letter: string) =>
    letter.toUpperCase(),
  );
}

/**
 * A referential-integrity failure, in whichever of its two opposite directions
 * actually occurred.
 *
 * PostgreSQL reports both through the same constraint, and the old single
 * message tried to cover both at once — which is how creating a customer with a
 * `shopId` that does not exist came back as *"still referenced by other
 * records … deactivate it instead of deleting it"*, advice for the other case
 * entirely. `DETAIL` is what separates them:
 *
 *   insert/update  Key (shop_id)=(6) is not present in table "shops".
 *   delete         Key (id)=(1) is (still) referenced from table "users".
 *
 * Only the identifiers are read out of it. The rest of `DETAIL` is never shown:
 * on a NOT NULL violation it is the entire failing row, values included.
 */
export type ReferenceViolation =
  { kind: 'missing'; message: string } | { kind: 'in-use'; message: string };

export function describeReferenceViolation(
  detail: string | undefined,
): ReferenceViolation | undefined {
  if (!detail) return undefined;

  const missing =
    /^Key \(([^)]*)\)=\(.*\) is not present in table "([^"]+)"/s.exec(detail);
  if (missing) {
    const columns = missing[1].split(', ').filter(Boolean);
    const label = ENTITY_LABELS[missing[2]]?.one;
    if (!label) return undefined;

    // The field hint only helps when there is a single column to name; a
    // composite key would have to list two, and those all have explicit
    // messages above anyway.
    const hint =
      columns.length === 1
        ? ` Check the "${camelCase(columns[0])}" value.`
        : '';
    return { kind: 'missing', message: `That ${label} does not exist.${hint}` };
  }

  const inUse = /is (?:still )?referenced from table "([^"]+)"/s.exec(detail);
  if (inUse) {
    const label = ENTITY_LABELS[inUse[1]]?.many;
    if (!label) return undefined;
    return {
      kind: 'in-use',
      // BR-48, BR-60 — the row is in use and deactivating is the way out.
      message: `This record is still used by existing ${label}. Deactivate it instead of deleting it.`,
    };
  }

  return undefined;
}

/**
 * A NOT NULL violation names its column, so say which field is missing rather
 * than "a required value". `DETAIL` is not consulted — for 23502 it is the
 * failing row in full.
 */
export function describeMissingValue(
  column: string | undefined,
): string | undefined {
  return column ? `The "${camelCase(column)}" value is required.` : undefined;
}

/**
 * Fallback messages by SQLSTATE, for a constraint neither named above nor
 * described by the two helpers.
 *
 * `23001` is the restrict violation raised by `ON DELETE RESTRICT`, which is
 * how most of this schema refuses a delete. It was missing here, so any such
 * delete the service layer had not already pre-checked returned 500.
 */
export const SQLSTATE_MESSAGES: Record<string, string> = {
  '23001':
    'This record is still used by other records. Deactivate it instead of deleting it.',
  '23502': 'A required value is missing.',
  '23503':
    'That record is still referenced by other records, or refers to something that no longer exists. Deactivate it instead of deleting it.',
  '23505': 'That value is already in use.',
  '23514': 'That change would break a business rule.',
  '40001': 'The record was changed by someone else. Please try again.',
  '40P01':
    'The operation conflicted with another in progress. Please try again.',
  '55P03':
    'That record is currently locked by another operation. Please try again.',
};
