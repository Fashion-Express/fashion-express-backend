/**
 * The sentences a referential failure produces.
 *
 * These assertions exist because the wording is derived from PostgreSQL's own
 * `DETAIL` line rather than from a table of a hundred hand-written constraint
 * names — which means the derivation is only correct for as long as `DETAIL`
 * keeps saying what it says today. Parsing it against a mock would prove
 * nothing; every error below is provoked by a real write to a real server.
 *
 * The bug that prompted them: creating a customer with a `shopId` that does not
 * exist answered *"still referenced by other records … deactivate it instead of
 * deleting it"* — advice for the opposite failure. One constraint, two
 * directions, and the old message described only one of them.
 */
import {
  captureError,
  closePool,
  loadFixture,
  migrateTestDatabase,
} from './harness';
import {
  describeMissingValue,
  describeReferenceViolation,
} from '../../src/common/constraint-messages';

jest.setTimeout(60_000);

beforeAll(async () => {
  await migrateTestDatabase();
  await loadFixture();
});

afterAll(async () => {
  await closePool();
});

const STATUS = (scope: string, code: string) =>
  `(SELECT id FROM statuses WHERE scope='${scope}' AND code='${code}')`;

describe('a reference that does not exist', () => {
  it('names the entity and the field, not the delete advice', async () => {
    const error = await captureError(
      `INSERT INTO customers (customer_id, name, phone, shop_id, status_id, status_scope)
       VALUES ('C-1', 'Niren Costa', '01548593022', 999999,
               ${STATUS('customer', 'active')}, 'customer')`,
    );

    expect(error.code).toBe('23503');
    expect(error.constraint).toBe('customers_shop_id_fkey');
    expect(describeReferenceViolation(error.detail)).toEqual({
      kind: 'missing',
      message: 'That shop does not exist. Check the "shopId" value.',
    });
  });

  it('reads the same on an update', async () => {
    const error = await captureError(
      `UPDATE customers SET shop_id = 999999 WHERE id = 1`,
    );
    expect(describeReferenceViolation(error.detail)?.message).toBe(
      'That shop does not exist. Check the "shopId" value.',
    );
  });

  it('drops the field hint for a composite key', async () => {
    const error = await captureError(
      `INSERT INTO inventory_items (shop_id, part_code, part_name, unit_id, supplier_id)
       VALUES (1, 'X-1', 'Widget', 999999, NULL)`,
    );
    expect(describeReferenceViolation(error.detail)).toEqual({
      kind: 'missing',
      message: 'That unit does not exist. Check the "unitId" value.',
    });
  });
});

describe('a record still in use', () => {
  it('keeps the deactivate-instead advice and names what is using it', async () => {
    // ON DELETE RESTRICT raises 23001, which the filter treated as unknown and
    // answered with a 500 until this was fixed.
    const error = await captureError(`DELETE FROM units WHERE id = 1`);

    expect(error.code).toBe('23001');
    expect(describeReferenceViolation(error.detail)).toEqual({
      kind: 'in-use',
      message:
        'This record is still used by existing products. Deactivate it instead of deleting it.',
    });
  });
});

describe('what the derivation refuses to do', () => {
  /**
   * On a NOT NULL violation `DETAIL` is the entire failing row, values and all.
   * The parser must not match it, and nothing may echo it.
   */
  it('never treats a failing-row dump as a reference', async () => {
    const error = await captureError(
      `INSERT INTO customers (customer_id, name, shop_id, status_id, status_scope)
       VALUES ('C-2', NULL, 1, ${STATUS('customer', 'active')}, 'customer')`,
    );

    expect(error.code).toBe('23502');
    expect(error.detail).toMatch(/Failing row contains/);
    expect(describeReferenceViolation(error.detail)).toBeUndefined();
    expect(describeMissingValue(error.column)).toBe(
      'The "name" value is required.',
    );
  });

  it('falls back rather than naming a table a user would not recognise', () => {
    expect(
      describeReferenceViolation(
        'Key (id)=(1) is referenced from table "migrations".',
      ),
    ).toBeUndefined();
  });
});
