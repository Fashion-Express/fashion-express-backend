/**
 * Phase 5 — sales (FR-02) and the customer lump-sum payment (FR-03.5).
 *
 * The rules that matter here are the ones where getting it wrong loses money or
 * stock: finalisation must be all-or-nothing (BR-06, BR-07), removing a line
 * must return the stock it consumed (BR-12), a lump sum must be applied
 * oldest-first and never exceed what is owed (BR-16, BR-17), and a non-manager
 * must not be able to reach another user's sale by any route (BR-01).
 */
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
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
let admin = '';
let manager = '';
let staff = '';
let staffId = '';
const ORIGIN = process.env.BETTER_AUTH_URL ?? 'http://localhost:3000';

const as = (cookie: string) => ({
  get: (p: string) => request(server).get(p).set('Cookie', cookie),
  post: (p: string, b?: Record<string, unknown>) =>
    request(server)
      .post(p)
      .set('Cookie', cookie)
      .send(b ?? {}),
  patch: (p: string, b: Record<string, unknown>) =>
    request(server).patch(p).set('Cookie', cookie).send(b),
  del: (p: string) => request(server).delete(p).set('Cookie', cookie),
});

async function signIn(username: string, password: string): Promise<string> {
  const r = await request(server)
    .post('/api/auth/sign-in/username')
    .set('Origin', ORIGIN)
    .send({ username, password });
  assert.equal(r.status, 200, `sign-in failed for ${username}: ${r.text}`);
  return (r.headers['set-cookie'] as unknown as string[])
    .map((c) => c.split(';')[0])
    .join('; ');
}

async function seed(username: string, typeCode: string): Promise<string> {
  const rows = await query<{ id: string }>(
    `INSERT INTO users (username, display_username, name, email, employee_id,
                        user_type_id, status_id, shop_id)
     SELECT lower($1), $1, $1, $2, $3,
            (SELECT id FROM user_types WHERE code = $4),
            (SELECT id FROM statuses WHERE scope='user' AND code='active'), 1
     RETURNING id::text`,
    [username, `${username}@fe.test`, `EMP-${username}`, typeCode],
  );
  await createCredential(rows[0].id, 'Sales-Test-Pass-1');
  return rows[0].id;
}

async function methodId(scope: string, code: string): Promise<string> {
  const rows = await query<{ id: string }>(
    `SELECT id::text FROM payment_methods WHERE scope = $1 AND code = $2`,
    [scope, code],
  );
  return rows[0].id;
}

/** A product in shop 1 with plenty of stock, for sales that must succeed. */
async function stockedProduct(quantity = '1000'): Promise<string> {
  const rows = await query<{ id: string }>(
    `INSERT INTO inventory_items (shop_id, part_code, part_name, unit_id,
                                  quantity, box_count, unit_price, minimum_stock)
     SELECT 1, $1, 'Test product', (SELECT id FROM units WHERE code='pcs'),
            $2, 100, 100, 10
     RETURNING id::text`,
    [`SP-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`, quantity],
  );
  return rows[0].id;
}

async function customerId(): Promise<string> {
  const rows = await query<{ id: string }>(
    `SELECT id::text FROM customers WHERE shop_id = 1 ORDER BY id LIMIT 1`,
  );
  return rows[0].id;
}

before(async () => {
  await migrateTestDatabase();
  await loadFixture();
  await seed('salesadmin', 'owner');
  await seed('salesmgr', 'manager');
  staffId = await seed('salesstaff', 'employee');

  app = await createApp();
  await app.init();
  server = app.getHttpServer();

  admin = await signIn('salesadmin', 'Sales-Test-Pass-1');
  manager = await signIn('salesmgr', 'Sales-Test-Pass-1');
  staff = await signIn('salesstaff', 'Sales-Test-Pass-1');
});

after(async () => {
  await app.close();
  await closePool();
  await authPool.end();
});

describe('FR-02.2 creating a sale', () => {
  test('computes line totals and the order total; never accepts them', async () => {
    const product = await stockedProduct();
    const r = await as(admin).post('/api/sales', {
      customerId: await customerId(),
      shopId: '1',
      items: [
        {
          itemType: 'inventory',
          inventoryItemId: product,
          quantity: '3',
          unitPrice: '50.00',
        },
        {
          itemType: 'non_inventory',
          description: 'Lathe XL',
          quantity: '1',
          unitPrice: '25000.00',
        },
      ],
    });
    assert.equal(r.status, 201);
    assert.equal(r.body.total_amount, '25150.00');
    assert.equal(r.body.status_code, 'draft');
  });

  /** A blank price takes the product's price; a positive one always wins. */
  test('defaults a stocked line’s price from the product', async () => {
    const product = await stockedProduct();
    const r = await as(admin).post('/api/sales', {
      customerId: await customerId(),
      shopId: '1',
      items: [
        { itemType: 'inventory', inventoryItemId: product, quantity: '2' },
      ],
    });
    const items = await as(admin).get(`/api/sales/${r.body.id}/items`);
    assert.equal(items.body[0].unit_price, '100.00');
    assert.equal(items.body[0].line_total, '200.00');
  });

  test('a positive entered price wins over the product’s', async () => {
    const product = await stockedProduct();
    const r = await as(admin).post('/api/sales', {
      customerId: await customerId(),
      shopId: '1',
      items: [
        {
          itemType: 'inventory',
          inventoryItemId: product,
          quantity: '1',
          unitPrice: '7.50',
        },
      ],
    });
    const items = await as(admin).get(`/api/sales/${r.body.id}/items`);
    assert.equal(items.body[0].unit_price, '7.50');
  });

  test('BR-05 refuses a sale with no lines', async () => {
    const r = await as(admin).post('/api/sales', {
      customerId: await customerId(),
      shopId: '1',
      items: [],
    });
    assert.equal(r.status, 400);
  });

  test('BR-04 refuses a machine line with no description', async () => {
    const r = await as(admin).post('/api/sales', {
      customerId: await customerId(),
      shopId: '1',
      items: [{ itemType: 'non_inventory', quantity: '1', unitPrice: '10' }],
    });
    assert.equal(r.status, 400);
  });

  test('BR-04 refuses a stocked line with no product', async () => {
    const r = await as(admin).post('/api/sales', {
      customerId: await customerId(),
      shopId: '1',
      items: [{ itemType: 'inventory', quantity: '1', unitPrice: '10' }],
    });
    assert.equal(r.status, 400);
  });

  test('BR-50 refuses a line drawing on another shop’s stock', async () => {
    const other = await query<{ id: string }>(
      `SELECT id::text FROM inventory_items WHERE shop_id = 2 LIMIT 1`,
    );
    const r = await as(admin).post('/api/sales', {
      customerId: await customerId(),
      shopId: '1',
      items: [
        { itemType: 'inventory', inventoryItemId: other[0].id, quantity: '1' },
      ],
    });
    assert.equal(r.status, 409);
    assert.equal(r.body.constraint, 'fk_saleitem_inventory_shop');
  });

  test('BR-53 refuses a customer from another shop', async () => {
    const other = await query<{ id: string }>(
      `SELECT id::text FROM customers WHERE shop_id = 2 LIMIT 1`,
    );
    const product = await stockedProduct();
    const r = await as(admin).post('/api/sales', {
      customerId: other[0].id,
      shopId: '1',
      items: [
        { itemType: 'inventory', inventoryItemId: product, quantity: '1' },
      ],
    });
    assert.equal(r.status, 409);
    assert.equal(r.body.constraint, 'fk_sale_customer_shop');
  });
});

describe('FR-02.4 finalising', () => {
  test('BR-02 leaves stock untouched until finalisation', async () => {
    const product = await stockedProduct('10');
    await as(admin).post('/api/sales', {
      customerId: await customerId(),
      shopId: '1',
      items: [
        { itemType: 'inventory', inventoryItemId: product, quantity: '4' },
      ],
    });
    const item = await as(admin).get(`/api/inventory/${product}`);
    assert.equal(item.body.quantity, '10.000');
  });

  test('deducts stock and records a movement naming the sale', async () => {
    const product = await stockedProduct('10');
    const sale = await as(admin).post('/api/sales', {
      customerId: await customerId(),
      shopId: '1',
      items: [
        { itemType: 'inventory', inventoryItemId: product, quantity: '4' },
      ],
    });

    const r = await as(admin).post(`/api/sales/${sale.body.id}/finalize`);
    assert.equal(r.status, 201);
    assert.equal(r.body.sale.status_code, 'finalized');
    assert.ok(
      r.body.sale.finalized_at,
      'BR-07: a finalised sale must have a timestamp',
    );

    const item = await as(admin).get(`/api/inventory/${product}`);
    assert.equal(item.body.quantity, '6.000');

    const movements = await as(admin).get(
      `/api/inventory/${product}/movements`,
    );
    const out = movements.body.items.find(
      (m: { type_code: string }) => m.type_code === 'out',
    );
    assert.equal(out.reason, r.body.saleNumber);
  });

  /**
   * BR-06 is the one to get right: validate every line before deducting any.
   * Line-by-line validation would leave the first line issued when the second
   * turned out to be short.
   */
  test('BR-06 refuses the whole sale if any line is short, changing nothing', async () => {
    const plenty = await stockedProduct('100');
    const scarce = await stockedProduct('1');

    const sale = await as(admin).post('/api/sales', {
      customerId: await customerId(),
      shopId: '1',
      items: [
        { itemType: 'inventory', inventoryItemId: plenty, quantity: '5' },
        { itemType: 'inventory', inventoryItemId: scarce, quantity: '999' },
      ],
    });

    const r = await as(admin).post(`/api/sales/${sale.body.id}/finalize`);
    assert.equal(r.status, 400);
    assert.match(r.body.message, /Nothing has been changed/);

    // The line that *could* have been filled must be untouched.
    const untouched = await as(admin).get(`/api/inventory/${plenty}`);
    assert.equal(untouched.body.quantity, '100.000');
  });

  test('FR-02.4.2 reports which items are now low', async () => {
    const product = await stockedProduct('12');
    const sale = await as(admin).post('/api/sales', {
      customerId: await customerId(),
      shopId: '1',
      items: [
        { itemType: 'inventory', inventoryItemId: product, quantity: '5' },
      ],
    });
    const r = await as(admin).post(`/api/sales/${sale.body.id}/finalize`);
    // 12 - 5 = 7, at or below the minimum of 10.
    assert.equal(r.body.nowLowOnStock.length, 1);
    assert.equal(r.body.nowLowOnStock[0].quantity, '7.000');
  });

  test('BR-08 refuses a second finalisation', async () => {
    const product = await stockedProduct();
    const sale = await as(admin).post('/api/sales', {
      customerId: await customerId(),
      shopId: '1',
      items: [
        { itemType: 'inventory', inventoryItemId: product, quantity: '1' },
      ],
    });
    await as(admin).post(`/api/sales/${sale.body.id}/finalize`);
    const again = await as(admin).post(`/api/sales/${sale.body.id}/finalize`);
    assert.equal(again.status, 400);
    assert.match(again.body.message, /already finalised/);
  });

  test('FR-02.4.3 finalising needs its own permission', async () => {
    const product = await stockedProduct();
    const sale = await as(staff).post('/api/sales', {
      customerId: await customerId(),
      shopId: '1',
      items: [
        { itemType: 'inventory', inventoryItemId: product, quantity: '1' },
      ],
    });
    // The employee type grants add_sale but not finalize_sale.
    const r = await as(staff).post(`/api/sales/${sale.body.id}/finalize`);
    assert.equal(r.status, 403);
  });

  test('BR-14 only draft sales may be deleted', async () => {
    const product = await stockedProduct();
    const sale = await as(admin).post('/api/sales', {
      customerId: await customerId(),
      shopId: '1',
      items: [
        { itemType: 'inventory', inventoryItemId: product, quantity: '1' },
      ],
    });
    assert.equal(
      (await as(admin).del(`/api/sales/${sale.body.id}`)).status,
      204,
    );

    const other = await as(admin).post('/api/sales', {
      customerId: await customerId(),
      shopId: '1',
      items: [
        { itemType: 'inventory', inventoryItemId: product, quantity: '1' },
      ],
    });
    await as(admin).post(`/api/sales/${other.body.id}/finalize`);
    const r = await as(admin).del(`/api/sales/${other.body.id}`);
    assert.equal(r.status, 400);
  });
});

describe('FR-02.3 quotations', () => {
  test('converts to a draft, preserving items and prices', async () => {
    const product = await stockedProduct();
    const quote = await as(admin).post('/api/sales', {
      customerId: await customerId(),
      shopId: '1',
      status: 'quote',
      items: [
        {
          itemType: 'inventory',
          inventoryItemId: product,
          quantity: '2',
          unitPrice: '33.00',
        },
      ],
    });
    assert.equal(quote.body.status_code, 'quote');

    const r = await as(admin).post(`/api/sales/${quote.body.id}/convert`);
    assert.equal(r.body.status_code, 'draft');
    assert.equal(r.body.total_amount, '66.00');
  });

  test('BR-11 a quotation takes an advance, and keeps it through convert', async () => {
    const product = await stockedProduct();
    const quote = await as(admin).post('/api/sales', {
      customerId: await customerId(),
      shopId: '1',
      status: 'quote',
      items: [
        {
          itemType: 'inventory',
          inventoryItemId: product,
          quantity: '1',
          unitPrice: '100.00',
        },
      ],
    });
    const r = await as(admin).post(`/api/sales/${quote.body.id}/payments`, {
      amount: '10.00',
      paymentDate: '2026-08-26',
      paymentMethodId: await methodId('customer', 'cash'),
    });
    assert.equal(r.status, 201);

    // BR-09 still holds against the quotation's own total.
    const over = await as(admin).post(`/api/sales/${quote.body.id}/payments`, {
      amount: '95.00',
      paymentDate: '2026-08-26',
      paymentMethodId: await methodId('customer', 'cash'),
    });
    assert.equal(over.status, 400);

    // Converting to a draft invoice carries the advance with it.
    const converted = await as(admin).post(
      `/api/sales/${quote.body.id}/convert`,
    );
    assert.equal(converted.body.status_code, 'draft');
    assert.equal(converted.body.amount_paid, '10.00');
  });

  test('BR-11 an advance may be taken as a quotation is created', async () => {
    const product = await stockedProduct();
    const quote = await as(admin).post('/api/sales', {
      customerId: await customerId(),
      shopId: '1',
      status: 'quote',
      items: [
        {
          itemType: 'inventory',
          inventoryItemId: product,
          quantity: '1',
          unitPrice: '100.00',
        },
      ],
      initialPayment: {
        amount: '25.00',
        paymentDate: '2026-08-26',
        paymentMethodId: await methodId('customer', 'cash'),
      },
    });
    assert.equal(quote.body.status_code, 'quote');
    assert.equal(quote.body.amount_paid, '25.00');
  });
});

describe('FR-02.5 payments', () => {
  async function finalisedSale(total = '1000'): Promise<string> {
    const product = await stockedProduct();
    const sale = await as(admin).post('/api/sales', {
      customerId: await customerId(),
      shopId: '1',
      items: [
        {
          itemType: 'inventory',
          inventoryItemId: product,
          quantity: '1',
          unitPrice: total,
        },
      ],
    });
    await as(admin).post(`/api/sales/${sale.body.id}/finalize`);
    return sale.body.id as string;
  }

  test('BR-09 refuses a payment above the balance', async () => {
    const id = await finalisedSale('1000');
    const r = await as(admin).post(`/api/sales/${id}/payments`, {
      amount: '1000.01',
      paymentDate: '2026-08-26',
      paymentMethodId: await methodId('customer', 'cash'),
    });
    assert.equal(r.status, 400);
  });

  test('BR-10 refuses zero', async () => {
    const id = await finalisedSale();
    const r = await as(admin).post(`/api/sales/${id}/payments`, {
      amount: '0',
      paymentDate: '2026-08-26',
      paymentMethodId: await methodId('customer', 'cash'),
    });
    assert.equal(r.status, 400);
  });

  test('BR-62 refuses a supplier-scoped method', async () => {
    const id = await finalisedSale();
    const r = await as(admin).post(`/api/sales/${id}/payments`, {
      amount: '10',
      paymentDate: '2026-08-26',
      paymentMethodId: await methodId('supplier', 'lc'),
    });
    assert.equal(r.status, 400);
  });

  test('part payments accumulate and post credits to the ledger', async () => {
    const id = await finalisedSale('1000');
    const cash = await methodId('customer', 'cash');

    const first = await as(admin).post(`/api/sales/${id}/payments`, {
      amount: '400.00',
      paymentDate: '2026-08-26',
      paymentMethodId: cash,
    });
    assert.equal(first.body.sale.amount_paid, '400.00');
    assert.equal(first.body.sale.balance_due, '600.00');

    await as(admin).post(`/api/sales/${id}/payments`, {
      amount: '600.00',
      paymentDate: '2026-08-26',
      paymentMethodId: cash,
    });

    const entries = await query<{ n: string }>(
      `SELECT count(*)::text AS n FROM ledger_entries e
         JOIN ledger_sources s ON s.id = e.source_id
         JOIN sale_payments p ON p.receipt_number = e.reference
        WHERE p.sale_id = $1 AND s.code = 'sale_payment'`,
      [id],
    );
    assert.equal(entries[0].n, '2');
  });
});

/**
 * BR-01 — "there is no route by which a non-manager can read another user's
 * sale." Every read path is checked, not just the list.
 */
describe('BR-01 sale visibility', () => {
  let adminSale: string;
  let staffSale: string;

  before(async () => {
    const product = await stockedProduct();
    adminSale = (
      await as(admin).post('/api/sales', {
        customerId: await customerId(),
        shopId: '1',
        items: [
          { itemType: 'inventory', inventoryItemId: product, quantity: '1' },
        ],
      })
    ).body.id;
    staffSale = (
      await as(staff).post('/api/sales', {
        customerId: await customerId(),
        shopId: '1',
        items: [
          { itemType: 'inventory', inventoryItemId: product, quantity: '1' },
        ],
      })
    ).body.id;
  });

  test('an employee sees only their own in the list', async () => {
    const r = await as(staff).get('/api/sales');
    assert.ok(r.body.items.length > 0);
    assert.ok(
      r.body.items.every(
        (s: { created_by_id: string }) => s.created_by_id === staffId,
      ),
    );
  });

  test('a manager sees everyone’s', async () => {
    const mine = await as(staff).get('/api/sales');
    const all = await as(manager).get('/api/sales');
    assert.ok(all.body.total > mine.body.total);
  });

  test('the detail page, items and payments are all scoped', async () => {
    for (const path of [
      `/api/sales/${adminSale}`,
      `/api/sales/${adminSale}/items`,
      `/api/sales/${adminSale}/payments`,
    ]) {
      const r = await as(staff).get(path);
      assert.equal(r.status, 404, path);
    }
    // And their own is reachable.
    assert.equal((await as(staff).get(`/api/sales/${staffSale}`)).status, 200);
  });

  /** FR-00.5 — using the filter as a non-manager must not widen visibility. */
  test('the created-by filter narrows, never widens', async () => {
    const adminId = (await as(admin).get('/api/me')).body.id;
    const r = await as(staff).get(`/api/sales?createdById=${adminId}`);
    assert.equal(r.body.total, 0);
  });
});

describe('FR-02.6 editing a finalised sale', () => {
  async function finalisedWithLine(): Promise<{
    saleId: string;
    itemId: string;
    product: string;
  }> {
    const product = await stockedProduct('50');
    const sale = await as(admin).post('/api/sales', {
      customerId: await customerId(),
      shopId: '1',
      items: [
        {
          itemType: 'inventory',
          inventoryItemId: product,
          quantity: '5',
          unitPrice: '100',
        },
      ],
    });
    await as(admin).post(`/api/sales/${sale.body.id}/finalize`);
    const items = await as(admin).get(`/api/sales/${sale.body.id}/items`);
    return { saleId: sale.body.id, itemId: items.body[0].id, product };
  }

  test('FR-02.6.1 a manager who is not an administrator cannot edit the lines', async () => {
    const { saleId, itemId } = await finalisedWithLine();
    // A manager can *see* it (BR-01), so this is the authorisation check rather
    // than the visibility one — which is exactly what FR-02.6.1 restricts.
    const r = await as(manager).del(`/api/sales/${saleId}/items/${itemId}`);
    assert.equal(r.status, 403);
    assert.match(r.body.message, /administrators/);
  });

  test('BR-12 removing a line returns the stock with a reversing movement', async () => {
    const { saleId, itemId, product } = await finalisedWithLine();
    const before = await as(admin).get(`/api/inventory/${product}`);
    assert.equal(before.body.quantity, '45.000');

    await as(admin).del(`/api/sales/${saleId}/items/${itemId}`);

    const after = await as(admin).get(`/api/inventory/${product}`);
    assert.equal(
      after.body.quantity,
      '50.000',
      'stock must never be silently lost',
    );

    const movements = await as(admin).get(
      `/api/inventory/${product}/movements`,
    );
    assert.equal(movements.body.items[0].type_code, 'adjustment');
    assert.match(movements.body.items[0].reason, /^Reversal of /);
  });

  test('BR-13 adding a line to a finalised sale deducts immediately', async () => {
    const { saleId, product } = await finalisedWithLine();
    const r = await as(admin).post(`/api/sales/${saleId}/items`, {
      itemType: 'inventory',
      inventoryItemId: product,
      quantity: '3',
      unitPrice: '100',
    });
    assert.equal(r.status, 201);

    const item = await as(admin).get(`/api/inventory/${product}`);
    assert.equal(item.body.quantity, '42.000');
  });

  /**
   * FR-02.6.2 — emptying a finalised sale reverts it to draft and deletes its
   * payments, so no orphaned overpayment remains. The ordering is load-bearing:
   * `sale_not_overpaid` fires on the statement that removes the line, so the
   * payments must go first.
   */
  test('FR-02.6.2 an emptied sale reverts to draft and its payments go', async () => {
    const { saleId, itemId } = await finalisedWithLine();
    await as(admin).post(`/api/sales/${saleId}/payments`, {
      amount: '500.00',
      paymentDate: '2026-08-26',
      paymentMethodId: await methodId('customer', 'cash'),
    });

    const r = await as(admin).del(`/api/sales/${saleId}/items/${itemId}`);
    assert.equal(r.status, 200);
    assert.equal(r.body.revertedToDraft, true);
    assert.equal(r.body.paymentsRemoved, 1);
    assert.equal(r.body.sale.status_code, 'draft');
    assert.equal(
      r.body.sale.finalized_at,
      null,
      'a stale timestamp would corrupt BR-16',
    );
    assert.equal(r.body.sale.amount_paid, '0.00');
  });
});

describe('FR-03.5 customer lump-sum payment', () => {
  /** Its own customer, so other tests' invoices do not perturb the ordering. */
  async function customerWithInvoices(
    amounts: string[],
  ): Promise<{ customer: string; sales: string[] }> {
    // The phone varies with the customer number: a customer's phone is unique
    // (migration 018), and this helper runs once per test in the suite.
    // Kept short: `phone` is varchar(20) and the prefix costs four of them.
    const token = `${Date.now() % 1_000_000_000}${Math.floor(Math.random() * 1000)}`;
    const rows = await query<{ id: string }>(
      `INSERT INTO customers (customer_id, shop_id, name, phone, status_id)
       SELECT $1, 1, 'FIFO Customer', $2,
              (SELECT id FROM statuses WHERE scope='customer' AND code='active')
       RETURNING id::text`,
      [`FE-FIFO-${token}`, `017-${token}`],
    );
    const customer = rows[0].id;
    const sales: string[] = [];

    for (const amount of amounts) {
      const product = await stockedProduct();
      const sale = await as(admin).post('/api/sales', {
        customerId: customer,
        shopId: '1',
        items: [
          {
            itemType: 'inventory',
            inventoryItemId: product,
            quantity: '1',
            unitPrice: amount,
          },
        ],
      });
      await as(admin).post(`/api/sales/${sale.body.id}/finalize`);
      sales.push(sale.body.id as string);
      // finalized_at orders the FIFO, so keep the timestamps distinct.
      await new Promise((r) => setTimeout(r, 15));
    }
    return { customer, sales };
  }

  test('BR-16 applies oldest finalised first, spilling into the next', async () => {
    const { customer, sales } = await customerWithInvoices([
      '100',
      '200',
      '300',
    ]);

    const r = await as(admin).post(`/api/customers/${customer}/payments`, {
      amount: '250.00',
      paymentDate: '2026-08-26',
      paymentMethodId: await methodId('customer', 'cash'),
    });
    assert.equal(r.status, 201);
    assert.equal(r.body.invoicesSettled, 2);
    assert.equal(r.body.allocations[0].amount, '100.00');
    assert.equal(r.body.allocations[1].amount, '150.00');

    const account = await as(admin).get(`/api/customers/${customer}/account`);
    const byId = Object.fromEntries(
      account.body.orders.map((o: { id: string }) => [o.id, o]),
    );
    assert.equal(byId[sales[0]].balance_due, '0.00');
    assert.equal(byId[sales[1]].balance_due, '50.00');
    assert.equal(
      byId[sales[2]].balance_due,
      '300.00',
      'the newest is untouched',
    );
  });

  test('BR-17 refuses more than the customer owes, writing nothing', async () => {
    const { customer } = await customerWithInvoices(['100']);
    const before = await query<{ n: string }>(
      `SELECT count(*)::text AS n FROM customer_payment_batches WHERE customer_id = $1`,
      [customer],
    );

    const r = await as(admin).post(`/api/customers/${customer}/payments`, {
      amount: '999999.00',
      paymentDate: '2026-08-26',
      paymentMethodId: await methodId('customer', 'cash'),
    });
    assert.equal(r.status, 400);

    const after = await query<{ n: string }>(
      `SELECT count(*)::text AS n FROM customer_payment_batches WHERE customer_id = $1`,
      [customer],
    );
    assert.equal(after[0].n, before[0].n, 'the whole event must be rejected');
  });

  /** BR-18 — a real payment row per sale, so per-invoice history stays printable. */
  test('BR-18 each sale touched gets its own payment and receipt', async () => {
    const { customer, sales } = await customerWithInvoices(['100', '200']);
    const r = await as(admin).post(`/api/customers/${customer}/payments`, {
      amount: '150.00',
      paymentDate: '2026-08-26',
      paymentMethodId: await methodId('customer', 'cash'),
    });

    const receipts = new Set(
      r.body.allocations.map((a: { receiptNumber: string }) => a.receiptNumber),
    );
    assert.equal(
      receipts.size,
      r.body.allocations.length,
      'receipts must be distinct',
    );

    const payments = await as(admin).get(`/api/sales/${sales[0]}/payments`);
    assert.equal(payments.body.length, 1);
    assert.equal(payments.body[0].amount, '100.00');
  });

  /** BR-19 — the whole event under one reference, with a combined receipt. */
  test('BR-19 groups the event and rebuilds a combined receipt', async () => {
    const { customer } = await customerWithInvoices(['100', '200']);
    const r = await as(admin).post(`/api/customers/${customer}/payments`, {
      amount: '250.00',
      paymentDate: '2026-08-26',
      paymentMethodId: await methodId('customer', 'cash'),
    });

    const combined = await as(admin).get(
      `/api/customer-payments/${r.body.batchRef}`,
    );
    assert.equal(combined.status, 200);
    assert.equal(combined.body.total_amount, '250.00');
    assert.equal(combined.body.allocations.length, 2);
    assert.equal(
      combined.body.allocations.reduce(
        (sum: number, a: { amount: string }) => sum + Number(a.amount),
        0,
      ),
      250,
    );
  });

  test('FR-03.5.1 reports the outstanding balance so the action can be hidden', async () => {
    const { customer } = await customerWithInvoices(['100']);
    const owing = await as(admin).get(`/api/customers/${customer}/outstanding`);
    assert.equal(owing.body.outstanding, '100.00');

    await as(admin).post(`/api/customers/${customer}/payments`, {
      amount: '100.00',
      paymentDate: '2026-08-26',
      paymentMethodId: await methodId('customer', 'cash'),
    });
    const settled = await as(admin).get(
      `/api/customers/${customer}/outstanding`,
    );
    assert.equal(settled.body.outstanding, '0.00');
  });
});

/**
 * The invariant the whole ledger design rests on: the balance equals the sum of
 * the records behind it (BR-40). Asserted last, after everything above has
 * created, edited and deleted payments on both sides.
 */
describe('FR-08 the ledger still reconciles', () => {
  test('balance equals sale credits minus supplier debits', async () => {
    const rows = await query<{
      balance: string;
      credits: string;
      debits: string;
    }>(
      `SELECT
         (SELECT COALESCE(SUM(e.amount * t.direction), 0)::text
            FROM ledger_entries e JOIN ledger_entry_types t ON t.id = e.entry_type_id) AS balance,
         (SELECT COALESCE(SUM(amount), 0)::text FROM sale_payments) AS credits,
         (SELECT COALESCE(SUM(amount), 0)::text FROM supplier_purchase_payments) AS debits`,
    );
    const { balance, credits, debits } = rows[0];
    assert.equal(Number(balance), Number(credits) - Number(debits));
  });
});

describe('FR-02.5a / BR-67..BR-69 the sale discount', () => {
  async function saleOf(total = '1000'): Promise<string> {
    const product = await stockedProduct();
    const sale = await as(admin).post('/api/sales', {
      customerId: await customerId(),
      shopId: '1',
      items: [
        {
          itemType: 'inventory',
          inventoryItemId: product,
          quantity: '1',
          unitPrice: total,
        },
      ],
    });
    await as(admin).post(`/api/sales/${sale.body.id}/finalize`);
    return sale.body.id as string;
  }

  const pay = async (id: string, amount: string) =>
    as(admin).post(`/api/sales/${id}/payments`, {
      amount,
      paymentDate: '2026-08-26',
      paymentMethodId: await methodId('customer', 'cash'),
    });

  test('reduces the payable total and records who applied it', async () => {
    const id = await saleOf('1000');
    const r = await as(admin).patch(`/api/sales/${id}/discount`, {
      amount: '200.00',
      reason: 'Damaged packaging',
    });

    assert.equal(r.status, 200);
    assert.equal(r.body.discount_amount, '200.00');
    assert.equal(r.body.total_amount, '800.00');
    assert.equal(r.body.balance_due, '800.00');
    // The line subtotal is recovered, not stored — the invoice needs both.
    assert.equal(r.body.subtotal_amount, '1000.00');
    assert.equal(r.body.discount_reason, 'Damaged packaging');
    assert.ok(r.body.discounted_at);
    assert.ok(r.body.discounted_by);
  });

  test('BR-67 a discount is not a payment — amount_paid is untouched', async () => {
    const id = await saleOf('1000');
    await as(admin).patch(`/api/sales/${id}/discount`, { amount: '300.00' });
    const r = await as(admin).get(`/api/sales/${id}`);
    assert.equal(r.body.amount_paid, '0.00');
    assert.equal(r.body.total_amount, '700.00');
  });

  test('BR-68 refuses a discount larger than the sale itself', async () => {
    const id = await saleOf('1000');
    const r = await as(admin).patch(`/api/sales/${id}/discount`, {
      amount: '1500.00',
    });
    assert.equal(r.status, 400);
    assert.match(r.body.message, /cannot exceed the 1000.00/);
  });

  test('BR-68 refuses a discount that undercuts what is already paid', async () => {
    const id = await saleOf('1000');
    await pay(id, '800.00');

    const r = await as(admin).patch(`/api/sales/${id}/discount`, {
      amount: '300.00',
    });
    assert.equal(r.status, 400);
    // The message must name the ceiling, not just refuse.
    assert.match(r.body.message, /most you can discount is 200.00/);
  });

  test('BR-68 allows a discount down to exactly the amount paid', async () => {
    const id = await saleOf('1000');
    await pay(id, '800.00');

    const r = await as(admin).patch(`/api/sales/${id}/discount`, {
      amount: '200.00',
    });
    assert.equal(r.status, 200);
    assert.equal(r.body.total_amount, '800.00');
    assert.equal(r.body.balance_due, '0.00');
  });

  test('BR-69 freezes the discount once the sale is settled', async () => {
    const id = await saleOf('1000');
    await pay(id, '1000.00');

    const r = await as(admin).patch(`/api/sales/${id}/discount`, {
      amount: '50.00',
    });
    assert.equal(r.status, 400);
    assert.match(r.body.message, /fully paid/);
  });

  test('a second call replaces the discount rather than adding to it', async () => {
    const id = await saleOf('1000');
    await as(admin).patch(`/api/sales/${id}/discount`, { amount: '100.00' });
    const r = await as(admin).patch(`/api/sales/${id}/discount`, {
      amount: '250.00',
    });
    assert.equal(r.body.discount_amount, '250.00');
    assert.equal(r.body.total_amount, '750.00');
  });

  test('zero clears the discount and its author, restoring the total', async () => {
    const id = await saleOf('1000');
    await as(admin).patch(`/api/sales/${id}/discount`, {
      amount: '200.00',
      reason: 'Goodwill',
    });

    const r = await as(admin).patch(`/api/sales/${id}/discount`, { amount: '0' });
    assert.equal(r.status, 200);
    assert.equal(r.body.discount_amount, '0.00');
    assert.equal(r.body.total_amount, '1000.00');
    // The biconditional constraint requires the attribution to go too.
    assert.equal(r.body.discounted_at, null);
    assert.equal(r.body.discounted_by, null);
  });

  test('BR-67 a cancelled sale cannot be discounted', async () => {
    // Deliberately NOT finalised: a finalised sale cannot change state at all,
    // so cancelling one is refused long before the discount is reached.
    const product = await stockedProduct();
    const sale = await as(admin).post('/api/sales', {
      customerId: await customerId(),
      shopId: '1',
      items: [
        {
          itemType: 'inventory',
          inventoryItemId: product,
          quantity: '1',
          unitPrice: '1000',
        },
      ],
    });
    const id = sale.body.id as string;

    const cancelled = await as(admin).patch(`/api/sales/${id}`, {
      status: 'cancelled',
    });
    assert.equal(cancelled.body.status_code, 'cancelled');

    const r = await as(admin).patch(`/api/sales/${id}/discount`, {
      amount: '10.00',
    });
    assert.equal(r.status, 400);
    assert.match(r.body.message, /cancelled/);
  });

  test('a later line change keeps the discount applied', async () => {
    const id = await saleOf('1000');
    await as(admin).patch(`/api/sales/${id}/discount`, { amount: '200.00' });

    const product = await stockedProduct();
    await as(admin).post(`/api/sales/${id}/items`, {
      itemType: 'inventory',
      inventoryItemId: product,
      quantity: '1',
      unitPrice: '500.00',
    });

    const r = await as(admin).get(`/api/sales/${id}`);
    assert.equal(r.body.subtotal_amount, '1500.00');
    assert.equal(r.body.total_amount, '1300.00');
  });

  /*
   * FR-02.6.2 — the regression this rule most easily breaks. Emptying the sale
   * takes the subtotal to zero; a discount left attached would drive the total
   * negative and `sale_not_overpaid` would refuse the deletion outright, so the
   * documented revert-to-draft would stop working for any discounted sale.
   */
  test('FR-02.6.2 removing the last line of a discounted sale still reverts it', async () => {
    const id = await saleOf('1000');
    await as(admin).patch(`/api/sales/${id}/discount`, { amount: '200.00' });

    const items = await as(admin).get(`/api/sales/${id}/items`);
    const r = await as(admin).del(`/api/sales/${id}/items/${items.body[0].id}`);

    assert.equal(r.status, 200);
    assert.equal(r.body.revertedToDraft, true);
    assert.equal(r.body.sale.discount_amount, '0.00');
    assert.equal(r.body.sale.total_amount, '0.00');
  });
});
