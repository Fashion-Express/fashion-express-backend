/**
 * Phase 4 — shops, customers, inventory and suppliers.
 *
 * The rules worth testing here are the ones that span records: a shop that
 * cannot be deleted because it holds trading data, a product code unique only
 * within its shop, a movement log that must describe an edit correctly, and the
 * supplier money path where the ledger has to stay equal to the payments behind
 * it.
 */
import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, test } from 'node:test';
import 'dotenv/config';
import type { NestExpressApplication } from '@nestjs/platform-express';
import type { Server } from 'node:http';
import request from 'supertest';
import { authPool } from '../../src/config/auth-pool';
import { createCredential } from '../../src/modules/auth/credentials';
import { createApp } from '../../src/main';
import {
  closePool,
  loadFixture,
  migrateTestDatabase,
  query,
} from '../schema/harness';

process.env.NODE_ENV = 'test';
if (!process.env.DATABASE_URL_TEST) {
  throw new Error('DATABASE_URL_TEST must be set to run the e2e suites.');
}

let app: NestExpressApplication;
let server: Server;
let owner: string;

const ORIGIN = process.env.BETTER_AUTH_URL ?? 'http://localhost:3000';

const get = (path: string) => request(server).get(path).set('Cookie', owner);
const post = (path: string, body?: Record<string, unknown>) =>
  request(server)
    .post(path)
    .set('Cookie', owner)
    .send(body ?? {});
const patch = (path: string, body: Record<string, unknown>) =>
  request(server).patch(path).set('Cookie', owner).send(body);
const del = (path: string) => request(server).delete(path).set('Cookie', owner);

async function methodId(scope: string, code: string): Promise<string> {
  const rows = await query<{ id: string }>(
    `SELECT id::text FROM payment_methods WHERE scope = $1 AND code = $2`,
    [scope, code],
  );
  return rows[0].id;
}
async function unitId(): Promise<string> {
  const rows = await query<{ id: string }>(
    `SELECT id::text FROM units WHERE code = 'pcs'`,
  );
  return rows[0].id;
}

before(async () => {
  await migrateTestDatabase();
  await loadFixture();

  const rows = await query<{ id: string }>(
    `INSERT INTO users (username, display_username, name, email, employee_id,
                        user_type_id, status_id, shop_id)
     SELECT 'trader', 'trader', 'Trader', 'trader@fe.test', 'EMP-trader',
            (SELECT id FROM user_types WHERE code = 'owner'),
            (SELECT id FROM statuses WHERE scope='user' AND code='active'), 1
     RETURNING id::text`,
  );
  await createCredential(rows[0].id, 'Trader-Pass-123');

  app = await createApp();
  await app.init();
  server = app.getHttpServer();

  const signIn = await request(server)
    .post('/api/auth/sign-in/username')
    .set('Origin', ORIGIN)
    .send({ username: 'trader', password: 'Trader-Pass-123' });
  owner = (signIn.headers['set-cookie'] as unknown as string[])
    .map((c) => c.split(';')[0])
    .join('; ');
});

after(async () => {
  await app.close();
  await closePool();
  await authPool.end();
});

describe('FR-11 shops', () => {
  test('the list counts what each shop holds (FR-11.2.2)', async () => {
    const response = await get('/api/shops');
    assert.equal(response.status, 200);
    const gulshan = response.body.items.find(
      (s: { name: string }) => s.name === 'Gulshan Branch',
    );
    // The fixture stocks one product and registers one customer per shop.
    assert.equal(gulshan.inventory_count, '1');
    assert.equal(gulshan.customer_count, '1');
  });

  test('BR-47 refuses a name differing only by case', async () => {
    const response = await post('/api/shops', { name: 'gulshan BRANCH' });
    assert.equal(response.status, 409);
    assert.equal(response.body.constraint, 'uq_shops_name_ci');
  });

  /** BR-48 — deletion exists only for a shop created in error and never used. */
  test('BR-48 refuses to delete a shop that holds trading data', async () => {
    const response = await del('/api/shops/1');
    assert.equal(response.status, 409);
    assert.match(response.body.message, /Deactivate it instead/);
  });

  test('an unused shop deletes, and deactivating is the alternative', async () => {
    const created = await post('/api/shops', { name: 'Temporary Outlet' });
    assert.equal(created.status, 201);

    const deactivated = await patch(`/api/shops/${created.body.id}`, {
      isActive: false,
    });
    assert.equal(deactivated.body.is_active, false);

    // FR-11.2.3 — an inactive shop leaves the pickers but keeps its history.
    const options = await get('/api/shops/options');
    assert.ok(
      !options.body.some(
        (s: { name: string }) => s.name === 'Temporary Outlet',
      ),
    );

    assert.equal((await del(`/api/shops/${created.body.id}`)).status, 204);
  });
});

describe('FR-03 customers', () => {
  test('issues a continuous customer number (RD-01, BR-46)', async () => {
    const first = await post('/api/customers', {
      name: 'Serial One',
      phone: '01710000001',
      shopId: '1',
    });
    const second = await post('/api/customers', {
      name: 'Serial Two',
      phone: '01710000002',
      shopId: '1',
    });

    assert.match(first.body.customer_id, /^FE\d{8}-\d{2,}$/);
    const a = Number(first.body.customer_id.split('-')[1]);
    const b = Number(second.body.customer_id.split('-')[1]);
    assert.equal(b, a + 1, 'the serial must not restart or skip');
  });

  test('BR-54 fixes the shop at creation', async () => {
    const created = await post('/api/customers', {
      name: 'Fixed Shop',
      phone: '01710000003',
      shopId: '1',
    });
    const response = await patch(`/api/customers/${created.body.id}`, {
      shopId: '2',
    });
    assert.equal(response.status, 400);
  });

  test('the customer number is never editable (FR-03.2)', async () => {
    const created = await post('/api/customers', {
      name: 'No Rename',
      phone: '01710000004',
      shopId: '1',
    });
    const response = await patch(`/api/customers/${created.body.id}`, {
      customerId: 'FE-HACKED',
    });
    assert.equal(response.status, 400);
  });

  test('the picker is confined to one shop (BR-53)', async () => {
    const shopOne = await get('/api/customers/options?shopId=1');
    const shopTwo = await get('/api/customers/options?shopId=2');
    assert.ok(shopOne.body.length > 0);
    assert.ok(shopTwo.body.length > 0);
    const overlap = shopOne.body.filter((a: { id: string }) =>
      shopTwo.body.some((b: { id: string }) => b.id === a.id),
    );
    assert.deepEqual(overlap, []);
  });

  /**
   * A phone number and an email address each identify one customer.
   *
   * Reported from the field: the same person could be entered twice and end up
   * as two records with two balances. The guarantee is a pair of unique indexes
   * (migration 018); these assert the sentence the API gives back, which names
   * who already holds the value so the duplicate can be found and edited.
   */
  test('refuses a second customer on the same phone number', async () => {
    const first = await post('/api/customers', {
      name: 'Niren Costa',
      phone: '01548593022',
      shopId: '1',
    });
    assert.equal(first.status, 201);

    const second = await post('/api/customers', {
      name: 'N. Costa',
      phone: '01548593022',
      shopId: '1',
    });
    assert.equal(second.status, 409);
    assert.match(second.body.message, /phone number already belongs to/i);
    assert.match(second.body.message, /Niren Costa/);
    assert.match(second.body.message, /FE\d{8}-\d+/);
  });

  test('refuses it across shops too — the rule is not per shop', async () => {
    await post('/api/customers', {
      name: 'Cross Shop',
      phone: '01548500001',
      shopId: '1',
    });
    const other = await post('/api/customers', {
      name: 'Cross Shop Again',
      phone: '01548500001',
      shopId: '2',
    });
    assert.equal(other.status, 409);
  });

  test('refuses a second customer on the same email, ignoring case', async () => {
    await post('/api/customers', {
      name: 'Mailbox One',
      phone: '01548500002',
      email: 'orders@acme.test',
      shopId: '1',
    });
    const second = await post('/api/customers', {
      name: 'Mailbox Two',
      phone: '01548500003',
      email: 'Orders@Acme.TEST',
      shopId: '1',
    });
    assert.equal(second.status, 409);
    assert.match(second.body.message, /email address already belongs to/i);
  });

  test('a number differing only by spaces is the same number', async () => {
    await post('/api/customers', {
      name: 'Spaced',
      phone: '01548500004',
      shopId: '1',
    });
    const second = await post('/api/customers', {
      name: 'Spaced Again',
      phone: '  01548500004  ',
      shopId: '1',
    });
    assert.equal(second.status, 409);
  });

  test('stores the trimmed value, so the record matches the rule', async () => {
    const created = await post('/api/customers', {
      name: 'Trimmed',
      phone: '  01548500005  ',
      email: '  Trim@Acme.test  ',
      shopId: '1',
    });
    assert.equal(created.status, 201);
    assert.equal(created.body.phone, '01548500005');
    assert.equal(created.body.email, 'Trim@Acme.test');
  });

  test('email stays optional — blank is not a duplicate of blank', async () => {
    const a = await post('/api/customers', {
      name: 'No Mail One',
      phone: '01548500006',
      shopId: '1',
    });
    const b = await post('/api/customers', {
      name: 'No Mail Two',
      phone: '01548500007',
      shopId: '1',
    });
    assert.equal(a.status, 201);
    assert.equal(b.status, 201);
  });

  test('an update may not take another customer’s number', async () => {
    const target = await post('/api/customers', {
      name: 'Update Target',
      phone: '01548500008',
      shopId: '1',
    });
    const response = await patch(`/api/customers/${target.body.id}`, {
      phone: '01548593022',
    });
    assert.equal(response.status, 409);
  });

  test('but a customer may keep its own number through an edit', async () => {
    const target = await post('/api/customers', {
      name: 'Self Edit',
      phone: '01548500009',
      shopId: '1',
    });
    const response = await patch(`/api/customers/${target.body.id}`, {
      name: 'Self Edit Renamed',
      phone: '01548500009',
    });
    assert.equal(response.status, 200);
    assert.equal(response.body.name, 'Self Edit Renamed');
  });

  /** FR-03.6.1 — the confirmation screen counts what will be destroyed. */
  test('reports the deletion impact before anything is deleted', async () => {
    const response = await get('/api/customers/1/deletion-impact');
    assert.equal(response.status, 200);
    assert.equal(typeof response.body.sales, 'number');
    assert.equal(response.body.customer.id, '1');
  });
});

describe('FR-04 inventory', () => {
  let productId: string;

  beforeEach(async () => {
    const created = await post('/api/inventory', {
      partCode: `T-${Date.now()}`,
      partName: 'Test widget',
      shopId: '1',
      unitId: await unitId(),
      quantity: '50.500',
      boxCount: 4,
      unitPrice: '75.00',
      minimumStock: 10,
    });
    assert.equal(created.status, 201);
    productId = created.body.id;
  });

  test('BR-51 allows the same code in another shop but not twice in one', async () => {
    const code = `DUP-${Date.now()}`;
    assert.equal(
      (
        await post('/api/inventory', {
          partCode: code,
          partName: 'A',
          shopId: '1',
          unitId: await unitId(),
        })
      ).status,
      201,
    );
    assert.equal(
      (
        await post('/api/inventory', {
          partCode: code,
          partName: 'A',
          shopId: '2',
          unitId: await unitId(),
        })
      ).status,
      201,
      'the same code in a different shop is two independent products',
    );

    const duplicate = await post('/api/inventory', {
      partCode: code,
      partName: 'A',
      shopId: '1',
      unitId: await unitId(),
    });
    assert.equal(duplicate.status, 409);
    assert.equal(duplicate.body.constraint, 'uq_inventory_shop_part_code');
  });

  /** BR-26 — the two stock dimensions must be auditable independently. */
  test('opening stock writes separate unit and box movements', async () => {
    const response = await get(`/api/inventory/${productId}/movements`);
    assert.equal(response.body.items.length, 2);
    for (const movement of response.body.items) {
      assert.equal(movement.type_code, 'in');
      assert.equal(movement.reason, 'Initial stock');
    }
    const units = response.body.items.find(
      (m: { quantity: string }) => m.quantity !== '0.000',
    );
    const boxes = response.body.items.find(
      (m: { box_quantity: number }) => m.box_quantity !== 0,
    );
    assert.equal(units.new_quantity, '50.500');
    assert.equal(boxes.new_box_quantity, 4);
  });

  /**
   * FR-04.5.1's vocabulary is deliberately asymmetric: raising stock through an
   * edit is a Stock In, lowering it is an Adjustment. Stock leaving through an
   * edit is a correction; stock leaving through a sale is an issue.
   */
  test('a raise is Stock In and a reduction is an Adjustment', async () => {
    await patch(`/api/inventory/${productId}`, { quantity: '80.000' });
    let movements = (await get(`/api/inventory/${productId}/movements`)).body
      .items;
    assert.equal(movements[0].type_code, 'in');
    assert.equal(movements[0].reason, 'Stock added via edit');

    await patch(`/api/inventory/${productId}`, { quantity: '60.000' });
    movements = (await get(`/api/inventory/${productId}/movements`)).body.items;
    assert.equal(movements[0].type_code, 'adjustment');
    assert.equal(movements[0].reason, 'Stock adjusted via edit');
    assert.equal(movements[0].previous_quantity, '80.000');
    assert.equal(movements[0].new_quantity, '60.000');
  });

  test('an edit that changes nothing records no movement', async () => {
    const before = (await get(`/api/inventory/${productId}/movements`)).body
      .total;
    await patch(`/api/inventory/${productId}`, { partName: 'Renamed widget' });
    const after = (await get(`/api/inventory/${productId}/movements`)).body
      .total;
    assert.equal(after, before);
  });

  test('BR-23 refuses negative stock', async () => {
    const response = await patch(`/api/inventory/${productId}`, {
      quantity: '-1',
    });
    assert.equal(response.status, 422);
    assert.equal(
      response.body.constraint,
      'inventoryitem_quantity_non_negative',
    );
  });

  /** FR-04.4 — the summary describes the filter, not the page. */
  test('the summary bar respects the filter', async () => {
    const all = await get('/api/inventory');
    const shopTwo = await get('/api/inventory?shopId=2');
    assert.ok(
      Number(all.body.summary.product_count) >
        Number(shopTwo.body.summary.product_count),
    );
    // NFR-01 — money at money scale, not the 5dp of quantity x price.
    assert.match(all.body.summary.total_value, /^\d+\.\d{2}$/);
  });

  test('BR-24 low stock is quantity at or below the item’s own minimum', async () => {
    await patch(`/api/inventory/${productId}`, { quantity: '10.000' });
    const item = await get(`/api/inventory/${productId}`);
    assert.equal(item.body.minimum_stock, 10);
    assert.equal(item.body.is_low_stock, true, 'at the minimum counts as low');

    const low = await get('/api/inventory?lowStock=true');
    assert.ok(low.body.items.some((i: { id: string }) => i.id === productId));
  });

  test('BR-25 movements are read-only — there is no write route', async () => {
    const response = await post(`/api/inventory/${productId}/movements`, {
      quantity: '1',
    });
    assert.equal(response.status, 404);
  });
});

describe('FR-05 suppliers and purchases', () => {
  let supplierId: string;

  before(async () => {
    const created = await post('/api/suppliers', {
      name: `Acme ${Date.now()}`,
      phone: `018-${Date.now() % 1_000_000_000}`,
    });
    supplierId = created.body.id;
  });

  /**
   * One supplier per phone number and per email address — the same rule
   * customers got in migration 018, guaranteed by `uq_suppliers_phone` and
   * `uq_suppliers_email_ci` and answered here with a sentence naming who
   * already holds the value.
   */
  test('refuses a second supplier on the same phone number', async () => {
    const first = await post('/api/suppliers', {
      name: 'Karim Fabrics',
      phone: '01555000001',
    });
    assert.equal(first.status, 201);

    const second = await post('/api/suppliers', {
      name: 'Karim Fabrics Ltd',
      phone: '01555000001',
    });
    assert.equal(second.status, 409);
    assert.match(second.body.message, /phone number already belongs to/i);
    assert.match(second.body.message, /Karim Fabrics/);
    assert.match(second.body.message, /instead of creating a second record/i);
  });

  test('refuses a second supplier on the same email, ignoring case', async () => {
    await post('/api/suppliers', {
      name: 'Mail Metals',
      phone: '01555000002',
      email: 'sales@metals.test',
    });
    const second = await post('/api/suppliers', {
      name: 'Mail Metals Two',
      phone: '01555000003',
      email: 'Sales@Metals.TEST',
    });
    assert.equal(second.status, 409);
    assert.match(second.body.message, /email address already belongs to/i);
  });

  test('a number differing only by spaces is the same number', async () => {
    await post('/api/suppliers', {
      name: 'Spaced Supply',
      phone: '01555000004',
    });
    const second = await post('/api/suppliers', {
      name: 'Spaced Supply Two',
      phone: '  01555000004  ',
    });
    assert.equal(second.status, 409);
  });

  test('stores the trimmed value, so the record matches the rule', async () => {
    const created = await post('/api/suppliers', {
      name: 'Trimmed Supply',
      phone: '  01555000005  ',
      email: '  Trim@Metals.test  ',
    });
    assert.equal(created.status, 201);
    assert.equal(created.body.phone, '01555000005');
    assert.equal(created.body.email, 'Trim@Metals.test');
  });

  test('email stays optional — blank is not a duplicate of blank', async () => {
    const a = await post('/api/suppliers', {
      name: 'No Mail Supply One',
      phone: '01555000006',
    });
    const b = await post('/api/suppliers', {
      name: 'No Mail Supply Two',
      phone: '01555000007',
    });
    assert.equal(a.status, 201);
    assert.equal(b.status, 201);
  });

  test('an update may not take another supplier’s number', async () => {
    const target = await post('/api/suppliers', {
      name: 'Update Target Supply',
      phone: '01555000008',
    });
    const response = await patch(`/api/suppliers/${target.body.id}`, {
      phone: '01555000001',
    });
    assert.equal(response.status, 409);
  });

  test('but a supplier may keep its own number through an edit', async () => {
    const target = await post('/api/suppliers', {
      name: 'Self Edit Supply',
      phone: '01555000009',
    });
    const response = await patch(`/api/suppliers/${target.body.id}`, {
      name: 'Self Edit Supply Renamed',
      phone: '01555000009',
    });
    assert.equal(response.status, 200);
    assert.equal(response.body.name, 'Self Edit Supply Renamed');
  });

  test('BR-32 saves a purchase and its initial payment atomically', async () => {
    const response = await post(`/api/suppliers/${supplierId}/purchases`, {
      productName: 'Steel sheet',
      price: '1000.00',
      purchaseDate: '2026-08-01',
      initialPayment: '250.00',
      initialPaymentMethodId: await methodId('supplier', 'cash'),
    });
    assert.equal(response.status, 201);
    assert.equal(response.body.paid_amount, '250.00');
    assert.equal(response.body.due, '750.00');
  });

  test('BR-32 refuses an initial payment above the price, writing nothing', async () => {
    const before = await get(`/api/suppliers/${supplierId}/purchases`);

    const response = await post(`/api/suppliers/${supplierId}/purchases`, {
      productName: 'Too much',
      price: '100.00',
      purchaseDate: '2026-08-02',
      initialPayment: '500.00',
      initialPaymentMethodId: await methodId('supplier', 'cash'),
    });
    assert.equal(response.status, 422);
    assert.equal(response.body.constraint, 'purchase_not_overpaid');

    const after = await get(`/api/suppliers/${supplierId}/purchases`);
    assert.equal(
      after.body.length,
      before.body.length,
      'the purchase was rolled back',
    );
  });

  test('BR-29 requires a reference for LC but not for cash', async () => {
    const purchases = await get(`/api/suppliers/${supplierId}/purchases`);
    const purchaseId = purchases.body[0].id;

    const withoutReference = await post(
      `/api/purchases/${purchaseId}/payments`,
      {
        amount: '100.00',
        paymentDate: '2026-08-05',
        paymentMethodId: await methodId('supplier', 'lc'),
      },
    );
    assert.equal(withoutReference.status, 400);
    assert.match(
      withoutReference.body.message,
      /reference number is required/i,
    );

    const withReference = await post(`/api/purchases/${purchaseId}/payments`, {
      amount: '100.00',
      paymentDate: '2026-08-05',
      paymentMethodId: await methodId('supplier', 'lc'),
      referenceNumber: 'LC-99881',
    });
    assert.equal(withReference.status, 201);
  });

  test('BR-62 refuses a customer-scoped method on a supplier payment', async () => {
    const purchases = await get(`/api/suppliers/${supplierId}/purchases`);
    const response = await post(
      `/api/purchases/${purchases.body[0].id}/payments`,
      {
        amount: '10.00',
        paymentDate: '2026-08-05',
        paymentMethodId: await methodId('customer', 'cash'),
      },
    );
    assert.equal(response.status, 400);
  });

  test('BR-30 refuses a payment above the remaining due', async () => {
    const purchases = await get(`/api/suppliers/${supplierId}/purchases`);
    const response = await post(
      `/api/purchases/${purchases.body[0].id}/payments`,
      {
        amount: '99999.00',
        paymentDate: '2026-08-05',
        paymentMethodId: await methodId('supplier', 'cash'),
      },
    );
    assert.equal(response.status, 400);
    assert.match(response.body.message, /still due/);
  });

  /** BR-31 — oldest purchase first, by purchase date. */
  test('BR-31 allocates a supplier payment oldest purchase first', async () => {
    const supplier = await post('/api/suppliers', {
      name: `FIFO ${Date.now()}`,
      phone: `018-fifo-${Date.now() % 1_000_000}`,
    });
    const id = supplier.body.id;

    // Deliberately created out of date order, to prove the ordering is by date.
    for (const [name, price, date] of [
      ['Newest', '300.00', '2026-08-20'],
      ['Oldest', '400.00', '2026-07-15'],
      ['Middle', '500.00', '2026-08-01'],
    ] as Array<[string, string, string]>) {
      await post(`/api/suppliers/${id}/purchases`, {
        productName: name,
        price,
        purchaseDate: date,
      });
    }

    const response = await post(`/api/suppliers/${id}/pay`, {
      amount: '600.00',
      paymentDate: '2026-08-26',
      paymentMethodId: await methodId('supplier', 'cash'),
    });
    assert.equal(response.status, 201);

    const purchases = await get(`/api/suppliers/${id}/purchases`);
    const byName = Object.fromEntries(
      purchases.body.map((p: { product_name: string }) => [p.product_name, p]),
    );
    assert.equal(byName['Oldest'].due, '0.00', 'the oldest is cleared first');
    assert.equal(byName['Middle'].due, '300.00', 'then the next oldest');
    assert.equal(byName['Newest'].due, '300.00', 'the newest is untouched');
  });

  test('BR-31 refuses more than the supplier is owed', async () => {
    const response = await post(`/api/suppliers/${supplierId}/pay`, {
      amount: '999999.00',
      paymentDate: '2026-08-26',
      paymentMethodId: await methodId('supplier', 'cash'),
    });
    assert.equal(response.status, 400);
    assert.match(response.body.message, /this supplier is owed/);
  });
});

/**
 * BR-38 — the ledger writes itself whenever money moves, and BR-40 — it follows
 * every edit and delete. The invariant worth asserting is the one the whole
 * design rests on: the balance equals the sum of the records behind it.
 */
describe('FR-08 the ledger follows supplier payments', () => {
  async function balance(): Promise<string> {
    const rows = await query<{ balance: string }>(
      `SELECT COALESCE(SUM(e.amount * t.direction), 0)::text AS balance
         FROM ledger_entries e JOIN ledger_entry_types t ON t.id = e.entry_type_id`,
    );
    return rows[0].balance;
  }
  async function paymentsTotal(): Promise<string> {
    const rows = await query<{ total: string }>(
      `SELECT COALESCE(SUM(amount), 0)::text AS total FROM supplier_purchase_payments`,
    );
    return rows[0].total;
  }

  test('every payment posts a debit, and the balance matches', async () => {
    const paid = await paymentsTotal();
    assert.equal(await balance(), `-${paid}`);

    const sources = await query<{ code: string; n: string }>(
      `SELECT s.code, count(*)::text AS n FROM ledger_entries e
         JOIN ledger_sources s ON s.id = e.source_id GROUP BY s.code`,
    );
    assert.deepEqual(
      sources.map((s) => s.code),
      ['supplier_payment'],
      'nothing else has posted yet',
    );
  });

  test('BR-40 an edited payment updates its ledger entry', async () => {
    const payments = await query<{ id: string; receipt_number: string }>(
      `SELECT id::text, receipt_number FROM supplier_purchase_payments
        ORDER BY id LIMIT 1`,
    );
    await patch(`/api/purchase-payments/${payments[0].id}`, { amount: '1.00' });

    const entry = await query<{ amount: string }>(
      `SELECT amount::text FROM ledger_entries WHERE reference = $1`,
      [payments[0].receipt_number],
    );
    assert.equal(entry[0].amount, '1.00');
    assert.equal(await balance(), `-${await paymentsTotal()}`);
  });

  test('BR-40 a deleted payment removes its ledger entry', async () => {
    const payments = await query<{ id: string; receipt_number: string }>(
      `SELECT id::text, receipt_number FROM supplier_purchase_payments
        ORDER BY id LIMIT 1`,
    );
    await del(`/api/purchase-payments/${payments[0].id}`);

    const entry = await query(
      `SELECT id FROM ledger_entries WHERE reference = $1`,
      [payments[0].receipt_number],
    );
    assert.equal(entry.length, 0);
    assert.equal(await balance(), `-${await paymentsTotal()}`);
  });
});
