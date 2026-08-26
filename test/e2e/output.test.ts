/**
 * Phase 7 — the output layer: dashboard (FR-01), reports and exports (FR-09),
 * printable documents (FR-02.9) and administration (FR-10).
 *
 * Most of this presents what other phases record, so the tests concentrate on
 * the places where presentation can lie: a figure that ignores the filter above
 * it, an export that hands back text a spreadsheet will not sum, a document a
 * user should not be able to print, and a destructive tool that removes more
 * than it was asked to.
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
process.env.ENABLE_DATA_CLEANUP = 'true';
if (!process.env.DATABASE_URL_TEST) {
  throw new Error('DATABASE_URL_TEST must be set to run the e2e suites.');
}

let app: NestExpressApplication;
let server: Server;
let admin = '';
let staff = '';
let claimant = '';
let saleId = '';
let paymentId = '';
const ORIGIN = process.env.BETTER_AUTH_URL ?? 'http://localhost:3000';

/**
 * supertest picks a body parser from the content type. It has one for
 * `application/pdf`, but an `.xlsx` or a `.csv` comes back as a string or an
 * empty object, and `body.subarray` then does not exist. `responseType('blob')`
 * forces the raw bytes, which is what a download test needs to look at.
 */
const download = (cookie: string, path: string) =>
  request(server).get(path).set('Cookie', cookie).responseType('blob');

const as = (cookie: string) => ({
  get: (p: string) => request(server).get(p).set('Cookie', cookie),
  post: (p: string, b?: Record<string, unknown>) =>
    request(server)
      .post(p)
      .set('Cookie', cookie)
      .send(b ?? {}),
  patch: (p: string, b: Record<string, unknown>) =>
    request(server).patch(p).set('Cookie', cookie).send(b),
});

async function signIn(username: string): Promise<string> {
  const r = await request(server)
    .post('/api/auth/sign-in/username')
    .set('Origin', ORIGIN)
    .send({ username, password: 'Output-Pass-123' });
  assert.equal(r.status, 200, `sign-in failed for ${username}`);
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
  await createCredential(rows[0].id, 'Output-Pass-123');
  return rows[0].id;
}

before(async () => {
  await migrateTestDatabase();
  await loadFixture();
  await seed('outadmin', 'owner');
  await seed('outstaff', 'employee');

  // A bills-only type, for FR-01.7.
  const type = await query<{ id: string }>(
    `INSERT INTO user_types (code, label) VALUES ('claimant', 'Claimant')
     ON CONFLICT (code) DO UPDATE SET label = EXCLUDED.label RETURNING id::text`,
  );
  await query(
    `INSERT INTO user_type_permissions (user_type_id, permission_id)
     SELECT $1, p.id FROM permissions p
      WHERE p.codename IN ('submit_bill', 'view_my_bills')
     ON CONFLICT DO NOTHING`,
    [type[0].id],
  );
  const c = await query<{ id: string }>(
    `INSERT INTO users (username, display_username, name, email, employee_id,
                        user_type_id, status_id, shop_id)
     SELECT 'outclaim', 'outclaim', 'outclaim', 'oc@fe.test', 'EMP-outclaim',
            $1, (SELECT id FROM statuses WHERE scope='user' AND code='active'), 1
     RETURNING id::text`,
    [type[0].id],
  );
  await createCredential(c[0].id, 'Output-Pass-123');

  app = await createApp();
  await app.init();
  server = app.getHttpServer() as Server;

  admin = await signIn('outadmin');
  staff = await signIn('outstaff');
  claimant = await signIn('outclaim');

  // A finalised sale with a payment, so the documents have something to print.
  const product = await query<{ id: string }>(
    `INSERT INTO inventory_items (shop_id, part_code, part_name, unit_id,
                                  quantity, unit_price, minimum_stock)
     SELECT 1, 'OUT-1', 'Output widget', (SELECT id FROM units WHERE code='pcs'),
            100, 250, 10 RETURNING id::text`,
  );
  const customer = await query<{ id: string }>(
    `SELECT id::text FROM customers WHERE shop_id = 1 LIMIT 1`,
  );

  const sale = await as(admin).post('/api/sales', {
    customerId: customer[0].id,
    shopId: '1',
    items: [
      { itemType: 'inventory', inventoryItemId: product[0].id, quantity: '4' },
      {
        itemType: 'non_inventory',
        description: 'Lathe machine XL\nserial 88',
        quantity: '1',
        unitPrice: '9000.00',
      },
    ],
  });
  saleId = sale.body.id as string;
  await as(admin).post(`/api/sales/${saleId}/finalize`);
  await as(admin).post(`/api/sales/${saleId}/payments`, {
    amount: '500.00',
    paymentDate: '2026-08-26',
    paymentMethodId: (
      await query<{ id: string }>(
        `SELECT id::text FROM payment_methods WHERE scope='customer' AND code='cash'`,
      )
    )[0].id,
  });
  paymentId = (
    await query<{ id: string }>(
      `SELECT id::text FROM sale_payments WHERE sale_id = $1 LIMIT 1`,
      [saleId],
    )
  )[0].id;

  await as(admin).post('/api/expenses', {
    date: new Date().toISOString().slice(0, 10),
    amount: '1500.00',
    description: 'Office electricity',
    expenseCategoryId: (
      await query<{ id: string }>(
        `SELECT id::text FROM expense_categories LIMIT 1`,
      )
    )[0].id,
  });
});

after(async () => {
  await app.close();
  await closePool();
  await authPool.end();
});

describe('FR-01 dashboard', () => {
  test('reports the headline counts and sale figures', async () => {
    const r = await as(admin).get('/api/dashboard');
    assert.equal(r.status, 200);
    assert.equal(r.body.reduced, false);

    assert.ok(Number(r.body.headline.active_employees) > 0);
    assert.ok(Number(r.body.headline.inventory_items) > 0);
    assert.match(r.body.headline.stock_value, /^\d+\.\d{2}$/);
    assert.ok(Number(r.body.sales.finalized_count) > 0);
    // BR-03 — the totals cover finalised sales only.
    assert.match(r.body.sales.invoiced, /^\d+\.\d{2}$/);
  });

  /**
   * FR-01.4 — machine lines are grouped by the first *meaningful* line of the
   * description, so repeat sales of the same machine aggregate instead of
   * scattering one row per sale.
   */
  test('FR-01.4 tops products across both stocked and machine lines', async () => {
    const r = await as(admin).get('/api/dashboard');
    const kinds = new Set(
      r.body.topProducts.map((p: { item_type: string }) => p.item_type),
    );
    assert.ok(kinds.has('inventory'));
    assert.ok(kinds.has('non_inventory'));

    const machine = r.body.topProducts.find(
      (p: { item_type: string }) => p.item_type === 'non_inventory',
    );
    assert.equal(
      machine.label,
      'Lathe machine XL',
      'grouped by the first line, not the whole description',
    );
    assert.ok(r.body.topProducts.length <= 10);
  });

  /**
   * FR-01.8 — every figure is filterable by shop, **except** expenses and bill
   * claims, which are not shop-scoped and must say so rather than silently
   * ignoring the filter.
   */
  test('FR-01.8 the shop filter moves shop-scoped figures only', async () => {
    const all = await as(admin).get('/api/dashboard');
    const shopTwo = await as(admin).get('/api/dashboard?shopId=2');

    assert.notEqual(
      all.body.headline.inventory_items,
      shopTwo.body.headline.inventory_items,
    );
    // Business-wide, whatever the filter.
    assert.equal(
      all.body.businessWide.expenses_this_month,
      shopTwo.body.businessWide.expenses_this_month,
    );
    assert.match(shopTwo.body.businessWide.note, /not scoped to a shop/);
  });

  /** FR-01.7 — a bills-only user gets the reduced dashboard, not a 403. */
  test('FR-01.7 reduces the dashboard for a bills-only user', async () => {
    const r = await as(claimant).get('/api/dashboard');
    assert.equal(r.status, 200);
    assert.equal(r.body.reduced, true);
    assert.deepEqual(
      r.body.actions.map((a: { label: string }) => a.label),
      ['Submit a Bill', 'My Bills'],
    );

    // And an ordinary employee still gets the full one.
    assert.equal((await as(staff).get('/api/dashboard')).body.reduced, false);
  });

  /** FR-01.6 — the count that must appear on every page. */
  test('FR-01.6 serves a low-stock count, per shop', async () => {
    const all = await as(admin).get('/api/low-stock-count');
    assert.equal(typeof all.body.count, 'number');
    const shopTwo = await as(admin).get('/api/low-stock-count?shopId=2');
    assert.ok(shopTwo.body.count <= all.body.count);
  });
});

describe('FR-09 reports and exports', () => {
  test('FR-09.2 carries the balance through from the ledger', async () => {
    const r = await as(admin).get('/api/reports/summary');
    assert.equal(r.status, 200);

    const rows = await query<{ balance: string }>(
      `SELECT COALESCE(SUM(e.amount * t.direction), 0)::text AS balance
         FROM ledger_entries e JOIN ledger_entry_types t ON t.id = e.entry_type_id`,
    );
    assert.equal(r.body.ledger.balance, rows[0].balance);
  });

  /** FR-09.6 — reports break down by shop. Net profit deliberately is not. */
  test('FR-09.6 breaks down by shop', async () => {
    const r = await as(admin).get('/api/reports/summary');
    assert.ok(r.body.byShop.length >= 2);
    for (const shop of r.body.byShop) {
      assert.ok('invoiced' in shop);
      assert.ok('stock_value' in shop);
      assert.ok('attributed_expenses' in shop);
      assert.ok(
        !('net_profit' in shop),
        'per-shop net profit is not available',
      );
    }
  });

  test('FR-09.5 reports are manager-only', async () => {
    assert.equal((await as(staff).get('/api/reports/summary')).status, 403);
    assert.equal((await as(admin).get('/api/reports/summary')).status, 200);
  });

  /**
   * FR-09.3 — a real workbook, not a CSV with the wrong extension. A `.xlsx` is
   * a zip; if it does not open as one, nothing downstream will read it.
   */
  test('FR-09.3 exports a valid multi-sheet workbook', async () => {
    const r = await download(admin, '/api/reports/export/full');
    assert.equal(r.status, 200);
    assert.match(r.headers['content-type'], /spreadsheetml\.sheet/);
    assert.match(
      r.headers['content-disposition'],
      /attachment; filename=".*\.xlsx"/,
    );

    const body = r.body as Buffer;
    // PK.. — the zip magic every xlsx starts with.
    assert.equal(body.subarray(0, 2).toString('latin1'), 'PK');
    assert.ok(body.length > 5000);
  });

  test('FR-09.4 exports the customer summary', async () => {
    const r = await download(admin, '/api/reports/export/customers');
    assert.equal(r.status, 200);
    assert.equal((r.body as Buffer).subarray(0, 2).toString('latin1'), 'PK');
  });
});

describe('FR-02.9 documents', () => {
  const isPdf = (body: Buffer) =>
    body.subarray(0, 5).toString('latin1') === '%PDF-';

  test('prints an invoice', async () => {
    const r = await download(admin, `/api/documents/sales/${saleId}/invoice`);
    assert.equal(r.status, 200);
    assert.equal(r.headers['content-type'], 'application/pdf');
    assert.ok(isPdf(r.body as Buffer));
  });

  test('prints a receipt and a statement', async () => {
    for (const path of [
      `/api/documents/payments/${paymentId}/receipt`,
      `/api/documents/sales/${saleId}/statement`,
    ]) {
      const r = await download(admin, path);
      assert.equal(r.status, 200, path);
      assert.ok(isPdf(r.body as Buffer), path);
    }
  });

  /** A quotation must be a distinct document that says it is not an invoice. */
  test('a quotation prints on its own template', async () => {
    const customer = await query<{ id: string }>(
      `SELECT id::text FROM customers WHERE shop_id = 1 LIMIT 1`,
    );
    const product = await query<{ id: string }>(
      `SELECT id::text FROM inventory_items WHERE shop_id = 1 LIMIT 1`,
    );

    const quote = await as(admin).post('/api/sales', {
      customerId: customer[0].id,
      shopId: '1',
      status: 'quote',
      items: [
        {
          itemType: 'inventory',
          inventoryItemId: product[0].id,
          quantity: '1',
          unitPrice: '10',
        },
      ],
    });

    const r = await download(
      admin,
      `/api/documents/sales/${quote.body.id}/invoice`,
    );
    assert.equal(r.status, 200);
    assert.match(
      r.headers['content-disposition'],
      /quotation-/,
      'the filename must not say invoice',
    );
  });

  test('exports order history as CSV and PDF', async () => {
    const csv = await download(admin, '/api/documents/orders.csv');
    assert.equal(csv.status, 200);
    assert.match(csv.headers['content-type'], /text\/csv/);
    const text = (csv.body as Buffer).toString('utf8');
    assert.match(text.split('\r\n')[0], /^Sale number,Date,Status/);

    const pdf = await download(admin, '/api/documents/orders.pdf');
    assert.ok(isPdf(pdf.body as Buffer));
  });

  /**
   * BR-01 covers documents and exports as much as it covers the list — a
   * printable invoice is very much reading a sale.
   */
  test('BR-01 an employee cannot print another user’s sale', async () => {
    const r = await as(staff).get(`/api/documents/sales/${saleId}/invoice`);
    assert.equal(r.status, 404);
  });

  test('BR-01 the order export is scoped too', async () => {
    const mine = await download(staff, '/api/documents/orders.csv');
    const all = await download(admin, '/api/documents/orders.csv');
    const lines = (b: Buffer) => b.toString('utf8').split('\r\n').length;
    assert.ok(lines(all.body as Buffer) > lines(mine.body as Buffer));
  });
});

describe('FR-10 administration', () => {
  test('FR-10.1 business settings are readable by anyone, editable by managers', async () => {
    assert.equal(
      (await as(staff).get('/api/admin/business-settings')).status,
      200,
    );

    const updated = await as(admin).patch('/api/admin/business-settings', {
      name: 'Fashion Express Ltd',
      address: '12 Gulshan Ave, Dhaka',
      phone: '+880 1700 000000',
    });
    assert.equal(updated.status, 200);
    assert.equal(updated.body.name, 'Fashion Express Ltd');

    assert.equal(
      (await as(staff).patch('/api/admin/business-settings', { name: 'Nope' }))
        .status,
      403,
    );
  });

  test('FR-10.2 reports the role groups and their grants', async () => {
    const r = await as(admin).get('/api/admin/roles');
    assert.equal(r.status, 200);
    const owner = r.body.find((t: { code: string }) => t.code === 'owner');
    assert.equal(owner.is_superuser, true);
    assert.ok(Number(owner.permission_count) > 0);
  });

  describe('FR-10.3 data cleanup', () => {
    test('BR-41 is restricted to administrators', async () => {
      assert.equal((await as(staff).get('/api/admin/cleanup')).status, 403);
      assert.equal(
        (await as(staff).post('/api/admin/cleanup', { targets: ['expenses'] }))
          .status,
        403,
      );
    });

    test('BR-43 previews without a phrase and writes nothing', async () => {
      const before = await query<{ n: string }>(
        `SELECT count(*)::text AS n FROM expenses`,
      );

      const r = await as(admin).post('/api/admin/cleanup', {
        targets: ['expenses', 'billClaims'],
      });
      assert.equal(r.status, 201);
      assert.equal(r.body.preview, true);
      assert.ok(r.body.wouldRemove.expenses >= 1);

      const after = await query<{ n: string }>(
        `SELECT count(*)::text AS n FROM expenses`,
      );
      assert.equal(after[0].n, before[0].n);
    });

    test('BR-43 a near-miss phrase is still only a preview', async () => {
      const r = await as(admin).post('/api/admin/cleanup', {
        targets: ['expenses', 'billClaims'],
        confirmation: 'delete all selected data',
      });
      assert.equal(r.body.preview, true);
      assert.match(r.body.error, /did not match exactly/);
    });

    /**
     * The dependency check. Clearing expenses alone nulls
     * `bill_claims.expense_id`, leaving an approved claim with no expense —
     * which `billclaim_review_consistent` refuses part-way through. Better to
     * refuse up front than to fail halfway.
     */
    test('refuses a selection the database would reject part-way', async () => {
      const r = await as(admin).post('/api/admin/cleanup', {
        targets: ['expenses'],
      });
      assert.equal(r.status, 400);
      assert.match(r.body.message, /also requires "billClaims"/);
    });

    test('warns when money records are cleared without the ledger', async () => {
      const r = await as(admin).post('/api/admin/cleanup', {
        targets: ['expenses', 'billClaims'],
      });
      assert.match(r.body.ledgerWarning, /money in the balance/);

      const withLedger = await as(admin).post('/api/admin/cleanup', {
        targets: ['expenses', 'billClaims', 'ledger'],
      });
      assert.equal(withLedger.body.ledgerWarning, undefined);
    });

    /** BR-44 — administrators and the caller are preserved by default. */
    test('BR-44 preserves administrators unless the second phrase is given', async () => {
      await query(
        `INSERT INTO users (username, display_username, name, email, employee_id,
                            user_type_id, status_id)
         SELECT 'outadmin2', 'outadmin2', 'Second', 'a2@fe.test', 'EMP-outadmin2',
                (SELECT id FROM user_types WHERE code='owner'),
                (SELECT id FROM statuses WHERE scope='user' AND code='active')`,
      );

      const guarded = await as(admin).post('/api/admin/cleanup', {
        targets: ['users', 'billClaims'],
      });
      const override = await as(admin).post('/api/admin/cleanup', {
        targets: ['users', 'billClaims'],
        includeAdminsConfirmation: 'YES REMOVE ADMINISTRATOR ACCOUNTS',
      });

      assert.ok(
        override.body.wouldRemove.users > guarded.body.wouldRemove.users,
        'the override must widen the set',
      );
      assert.match(guarded.body.protections[1], /preserved/);
      assert.match(override.body.protections[1], /WILL be removed/);
      // The caller is excluded from both, always.
      assert.match(guarded.body.protections[0], /never deleted/);
    });

    test('BR-43 the exact phrase deletes', async () => {
      const r = await as(admin).post('/api/admin/cleanup', {
        targets: ['expenses', 'billClaims'],
        confirmation: 'DELETE ALL SELECTED DATA',
      });
      assert.equal(r.body.preview, false);
      assert.ok(r.body.totalRows >= 1);

      const after = await query<{ n: string }>(
        `SELECT count(*)::text AS n FROM expenses`,
      );
      assert.equal(after[0].n, '0');
    });
  });
});
