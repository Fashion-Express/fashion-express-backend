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
 * Fallback messages by SQLSTATE, for a constraint the map above does not name.
 * `23503` (foreign key) is worth a word: on a *delete* it almost always means
 * BR-48 or BR-60 — the row is still in use and should be deactivated instead.
 */
export const SQLSTATE_MESSAGES: Record<string, string> = {
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
