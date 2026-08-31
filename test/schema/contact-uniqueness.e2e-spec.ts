/**
 * A customer's and a supplier's phone number and email address are unique
 * (migrations 018 and 019).
 *
 * For customers this reverses DB_DESIGN.MD §4, which listed both as
 * deliberately not unique. The rule lives in four partial indexes, so the cases
 * worth pinning are the edges the partiality creates: blanks must stay
 * unconstrained, trimming and letter case must not open a way around it, and
 * for customers it must hold across shops rather than inside one.
 */
import {
  closePool,
  expectAccepted,
  expectRejectedBy,
  loadFixture,
  migrateTestDatabase,
} from './harness';

jest.setTimeout(60_000);

beforeAll(async () => {
  await migrateTestDatabase();
  await loadFixture();
});

afterAll(async () => {
  await closePool();
});

const ACTIVE = `(SELECT id FROM statuses WHERE scope='customer' AND code='active')`;

/** The fixture's customer 1: shop 1, phone 01700000000, no email. */
const insert = (
  customerId: string,
  phone: string,
  email = '',
  shop = 1,
) => `INSERT INTO customers (customer_id, shop_id, name, phone, email, status_id)
      VALUES ('${customerId}', ${shop}, 'Probe', '${phone}', '${email}', ${ACTIVE})`;

describe('phone numbers', () => {
  it('refuses a second customer with the same number', () =>
    expectRejectedBy('uq_customers_phone', insert('P-1', '01700000000')));

  it('refuses it across shops too — the rule is global, not per shop', () =>
    expectRejectedBy(
      'uq_customers_phone',
      insert('P-2', '01700000000', '', 2),
    ));

  it('refuses a number that differs only by surrounding space', () =>
    expectRejectedBy('uq_customers_phone', insert('P-3', ' 01700000000 ')));

  it('accepts a different number', () =>
    expectAccepted(insert('P-4', '01999999999')));

  /**
   * `phone` is NOT NULL but older rows may hold ''. The index is partial so
   * that blank never counts as a duplicate of blank — otherwise exactly one
   * customer in the whole business could be missing a number.
   */
  it('leaves blank numbers unconstrained', () =>
    expectAccepted(`${insert('P-5', '')}; ${insert('P-6', '')}`));
});

describe('email addresses', () => {
  it('refuses a second customer with the same address', () =>
    expectRejectedBy(
      'uq_customers_email_ci',
      insert('E-2', '01999000003', 'shop@acme.test'),
      [insert('E-1', '01999000002', 'shop@acme.test')],
    ));

  it('treats letter case as the same mailbox', () =>
    expectRejectedBy(
      'uq_customers_email_ci',
      insert('E-4', '01999000005', 'Shop@Acme.TEST'),
      [insert('E-3', '01999000004', 'shop@acme.test')],
    ));

  /** Email is optional and stored as '' when absent (§1). */
  it('leaves blank addresses unconstrained', () =>
    expectAccepted(
      `${insert('E-5', '01999000006', '')}; ${insert('E-6', '01999000007', '')}`,
    ));
});

/**
 * Suppliers are not shop-scoped at all (FR-11.4), so there is no per-shop
 * question here — only the same edges as above.
 */
describe('suppliers', () => {
  const supplier = (name: string, phone: string, email = '') =>
    `INSERT INTO suppliers (name, phone, email)
     VALUES ('${name}', '${phone}', '${email}')`;

  it('refuses a second supplier with the same number', () =>
    expectRejectedBy(
      'uq_suppliers_phone',
      supplier('Copy Metals', '01800000000'),
    ));

  it('refuses a number that differs only by surrounding space', () =>
    expectRejectedBy(
      'uq_suppliers_phone',
      supplier('Spaced Metals', ' 01800000000 '),
    ));

  it('refuses an address that differs only by case', () =>
    expectRejectedBy(
      'uq_suppliers_email_ci',
      supplier('Second', '01800000002', 'Sales@Acme.TEST'),
      [supplier('First', '01800000001', 'sales@acme.test')],
    ));

  it('accepts a different number and address', () =>
    expectAccepted(supplier('Beta Metals', '01899999999', 'beta@acme.test')));

  it('leaves blank addresses unconstrained', () =>
    expectAccepted(
      `${supplier('No Mail One', '01899000001')}; ${supplier('No Mail Two', '01899000002')}`,
    ));
});
