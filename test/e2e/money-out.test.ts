/**
 * Phase 6 — expenses (FR-06), bill claims (FR-07) and the ledger's read side
 * (FR-08.2, FR-08.3).
 *
 * The rules that matter: BR-33's asymmetry between creating and editing an
 * expense, BR-36's approval as a *single* action, BR-37's rejection creating
 * nothing, and a rebuild that reconciles without duplicating (BR-39).
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
let finance = '';
let staff = '';
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

async function signIn(username: string): Promise<string> {
  const r = await request(server)
    .post('/api/auth/sign-in/username')
    .set('Origin', ORIGIN)
    .send({ username, password: 'Money-Pass-123' });
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
  await createCredential(rows[0].id, 'Money-Pass-123');
  return rows[0].id;
}

async function categoryId(): Promise<string> {
  const rows = await query<{ id: string }>(
    `SELECT id::text FROM expense_categories ORDER BY sort_order LIMIT 1`,
  );
  return rows[0].id;
}

async function ledgerBalance(): Promise<string> {
  const rows = await query<{ balance: string }>(
    `SELECT COALESCE(SUM(e.amount * t.direction), 0)::text AS balance
       FROM ledger_entries e JOIN ledger_entry_types t ON t.id = e.entry_type_id`,
  );
  return rows[0].balance;
}

before(async () => {
  await migrateTestDatabase();
  await loadFixture();
  await seed('moneyadmin', 'owner');
  await seed('moneyfin', 'finance');
  await seed('moneystaff', 'employee');

  app = await createApp();
  await app.init();
  server = app.getHttpServer() as Server;

  admin = await signIn('moneyadmin');
  finance = await signIn('moneyfin');
  staff = await signIn('moneystaff');
});

after(async () => {
  await app.close();
  await closePool();
  await authPool.end();
});

describe('FR-06 expenses', () => {
  test('creating one posts a debit to the ledger (BR-38)', async () => {
    const before = Number(await ledgerBalance());
    const r = await as(admin).post('/api/expenses', {
      date: '2026-08-20',
      amount: '1500.00',
      description: 'Office electricity',
      expenseCategoryId: await categoryId(),
      paidTo: 'DESCO',
      receiptNumber: 'U-8891',
    });
    assert.equal(r.status, 201);
    assert.equal(Number(await ledgerBalance()), before - 1500);
  });

  /**
   * BR-33 — anyone with the add permission may create one, but only managers
   * may edit or delete. Finance is the account that proves it: it holds
   * `add_expense` and is not a manager.
   */
  test('BR-33 Finance may create but not edit or delete', async () => {
    const created = await as(finance).post('/api/expenses', {
      date: '2026-08-21',
      amount: '250.00',
      description: 'Courier',
      expenseCategoryId: await categoryId(),
    });
    assert.equal(created.status, 201);

    assert.equal(
      (
        await as(finance).patch(`/api/expenses/${created.body.id}`, {
          amount: '300.00',
        })
      ).status,
      403,
    );
    assert.equal(
      (await as(finance).del(`/api/expenses/${created.body.id}`)).status,
      403,
    );
    assert.equal(
      (
        await as(admin).patch(`/api/expenses/${created.body.id}`, {
          amount: '300.00',
        })
      ).status,
      200,
    );
  });

  test('BR-40 an edited amount moves its ledger entry', async () => {
    const created = await as(admin).post('/api/expenses', {
      date: '2026-08-22',
      amount: '100.00',
      description: 'Stationery',
      expenseCategoryId: await categoryId(),
    });
    await as(admin).patch(`/api/expenses/${created.body.id}`, {
      amount: '175.00',
    });

    const rows = await query<{ amount: string }>(
      `SELECT amount::text FROM ledger_entries WHERE reference = $1`,
      [`EXP-${created.body.id}`],
    );
    assert.equal(rows[0].amount, '175.00');
  });

  test('deleting one removes its ledger entry', async () => {
    const created = await as(admin).post('/api/expenses', {
      date: '2026-08-23',
      amount: '90.00',
      description: 'Tea',
      expenseCategoryId: await categoryId(),
    });
    const before = Number(await ledgerBalance());
    await as(admin).del(`/api/expenses/${created.body.id}`);
    assert.equal(Number(await ledgerBalance()), before + 90);

    const rows = await query(
      `SELECT id FROM ledger_entries WHERE reference = $1`,
      [`EXP-${created.body.id}`],
    );
    assert.equal(rows.length, 0);
  });

  /** FR-06.4 — an explicit range takes precedence over a month. */
  test('FR-06.4 date filters, and range beats month', async () => {
    const august = await as(admin).get('/api/expenses?month=2026-08');
    assert.ok(august.body.total > 0);

    const july = await as(admin).get('/api/expenses?month=2026-07');
    assert.equal(july.body.total, 0);

    const both = await as(admin).get(
      '/api/expenses?month=2026-07&from=2026-08-01&to=2026-08-31',
    );
    assert.equal(both.body.total, august.body.total, 'the range must win');
  });

  /** FR-06.5 — the filtered total and the ledger balance sit above the list. */
  test('FR-06.5 reports the filtered total and the ledger balance', async () => {
    const r = await as(admin).get('/api/expenses?month=2026-08');
    assert.match(r.body.filteredTotal, /^\d+\.\d{2}$/);
    assert.equal(r.body.ledgerBalance, await ledgerBalance());
  });
});

describe('FR-07 bill claims', () => {
  async function submit(amount = '1200.00'): Promise<string> {
    const r = await as(staff).post('/api/bill-claims', {
      amount,
      description: 'Client dinner',
      billDate: '2026-08-18',
    });
    assert.equal(r.status, 201);
    assert.equal(r.body.status_code, 'pending');
    return r.body.id as string;
  }

  test('a claim starts pending with no reviewer or expense', async () => {
    const id = await submit();
    const r = await as(staff).get(`/api/bill-claims/${id}`);
    assert.equal(r.body.status_code, 'pending');
    assert.equal(r.body.approved_by, null);
    assert.equal(r.body.approval_date, null);
    assert.equal(r.body.expense_id, null);
  });

  test('FR-07.3/FR-07.4 staff see their own, reviewers see everyone’s', async () => {
    await submit();
    const mine = await as(staff).get('/api/bill-claims');
    const all = await as(admin).get('/api/bill-claims');
    assert.ok(all.body.total >= mine.body.total);
    assert.ok(mine.body.items.length > 0);
    // FR-07.4's three figures.
    assert.ok('pending' in all.body.totals);
    assert.ok('approved' in all.body.totals);
    assert.ok('rejected' in all.body.totals);
  });

  test('an employee cannot review', async () => {
    const id = await submit();
    assert.equal(
      (await as(staff).post(`/api/bill-claims/${id}/approve`)).status,
      403,
    );
    assert.equal(
      (await as(staff).post(`/api/bill-claims/${id}/reject`)).status,
      403,
    );
  });

  /**
   * BR-36 — one action: mark approved, record who and when, create the expense
   * dated to the *bill* date with the employee as payee, and link the two.
   */
  test('BR-36 approval creates and links the expense in one action', async () => {
    const id = await submit('1200.00');
    const expensesBefore = await query<{ n: string }>(
      `SELECT count(*)::text AS n FROM expenses`,
    );

    const r = await as(admin).post(`/api/bill-claims/${id}/approve`);
    assert.equal(r.status, 201);
    assert.equal(r.body.status_code, 'approved');
    assert.equal(r.body.approved_by, 'moneyadmin');
    assert.ok(r.body.approval_date);
    assert.ok(r.body.expense_id);

    const expensesAfter = await query<{ n: string }>(
      `SELECT count(*)::text AS n FROM expenses`,
    );
    assert.equal(Number(expensesAfter[0].n), Number(expensesBefore[0].n) + 1);

    const expense = await as(admin).get(`/api/expenses/${r.body.expense_id}`);
    assert.equal(expense.body.date, '2026-08-18', 'dated to the bill date');
    assert.equal(expense.body.amount, '1200.00');
    assert.equal(
      expense.body.paid_to,
      'moneystaff',
      'the employee is the payee',
    );

    // FR-06.6 — the expense can be traced back to the claim and its people.
    assert.equal(expense.body.claim.id, id);
    assert.equal(expense.body.claim.submitted_by, 'moneystaff');
    assert.equal(expense.body.claim.approved_by, 'moneyadmin');
  });

  test('BR-35 an approved claim cannot be processed again', async () => {
    const id = await submit();
    await as(admin).post(`/api/bill-claims/${id}/approve`);

    for (const action of ['approve', 'reject']) {
      const r = await as(admin).post(`/api/bill-claims/${id}/${action}`);
      assert.equal(r.status, 400, action);
      assert.match(r.body.message, /already been approved/);
    }
  });

  /** BR-37 — rejection records the reviewer and date and creates no expense. */
  test('BR-37 rejection creates no expense', async () => {
    const id = await submit();
    const before = await query<{ n: string }>(
      `SELECT count(*)::text AS n FROM expenses`,
    );

    const r = await as(admin).post(`/api/bill-claims/${id}/reject`);
    assert.equal(r.body.status_code, 'rejected');
    assert.ok(r.body.approval_date);
    assert.equal(r.body.approved_by, 'moneyadmin');
    assert.equal(r.body.expense_id, null);

    const after = await query<{ n: string }>(
      `SELECT count(*)::text AS n FROM expenses`,
    );
    assert.equal(after[0].n, before[0].n);
  });

  test('a reviewed claim can no longer be edited or withdrawn', async () => {
    const id = await submit();
    await as(admin).post(`/api/bill-claims/${id}/reject`);
    assert.equal(
      (await as(staff).patch(`/api/bill-claims/${id}`, { amount: '5.00' }))
        .status,
      400,
    );
    assert.equal((await as(staff).del(`/api/bill-claims/${id}`)).status, 400);
  });

  /** BR-34 — a fixed extension whitelist; anything else is refused. */
  test('BR-34 accepts a whitelisted attachment and refuses others', async () => {
    const accepted = await request(server)
      .post('/api/bill-claims')
      .set('Cookie', staff)
      .field('amount', '800.00')
      .field('description', 'Hotel')
      .field('billDate', '2026-08-22')
      .attach('attachment', Buffer.from('receipt'), 'receipt.pdf');
    assert.equal(accepted.status, 201);
    assert.match(accepted.body.attachment, /\.pdf$/);

    const refused = await request(server)
      .post('/api/bill-claims')
      .set('Cookie', staff)
      .field('amount', '800.00')
      .field('description', 'Bad')
      .field('billDate', '2026-08-22')
      .attach('attachment', Buffer.from('#!/bin/sh'), 'evil.sh');
    assert.equal(refused.status, 400);
    assert.match(refused.body.message, /not an accepted attachment/);
  });

  /**
   * The stored name is generated, never the uploaded one — a caller-supplied
   * filename is a caller-supplied path.
   */
  test('the stored filename is generated, not the uploaded one', async () => {
    const r = await request(server)
      .post('/api/bill-claims')
      .set('Cookie', staff)
      .field('amount', '10.00')
      .field('description', 'Traversal attempt')
      .field('billDate', '2026-08-22')
      .attach('attachment', Buffer.from('x'), '../../../etc/passwd.txt');
    assert.equal(r.status, 201);
    assert.ok(!r.body.attachment.includes('..'));
    assert.ok(!r.body.attachment.includes('/'));
    assert.match(r.body.attachment, /^\d+-[0-9a-f]{12}\.txt$/);
  });
});

describe('FR-08.2 the ledger page', () => {
  test('lists newest first with credits, debits and the balance', async () => {
    const r = await as(admin).get('/api/ledger');
    assert.equal(r.status, 200);
    assert.equal(r.body.pageSize, 10);
    assert.ok('total_credits' in r.body.totals);
    assert.ok('total_debits' in r.body.totals);
    assert.equal(r.body.totals.balance, await ledgerBalance());

    // FR-12.12.2 — the signed value comes from the entry type's direction.
    for (const entry of r.body.items) {
      const expected =
        entry.entry_type === 'credit'
          ? Number(entry.amount)
          : -Number(entry.amount);
      assert.equal(Number(entry.signed_amount), expected);
    }
  });

  test('is manager-only (FR-09.5)', async () => {
    assert.equal((await as(staff).get('/api/ledger')).status, 403);
    assert.equal((await as(admin).get('/api/ledger')).status, 200);
  });

  test('BR-38 there is no way to post a line by hand', async () => {
    const r = await as(admin).post('/api/ledger', {
      entryType: 'credit',
      amount: '1000000.00',
    });
    assert.equal(r.status, 404);
  });
});

describe('FR-08.3 rebuilding the ledger', () => {
  test('previews by default and writes nothing', async () => {
    const before = await query<{ n: string }>(
      `SELECT count(*)::text AS n FROM ledger_entries`,
    );
    const r = await as(admin).post('/api/ledger/rebuild');
    assert.equal(r.body.preview, true);
    const after = await query<{ n: string }>(
      `SELECT count(*)::text AS n FROM ledger_entries`,
    );
    assert.equal(after[0].n, before[0].n);
  });

  /**
   * `?preview=false` must actually write. It did not, for a while: `@Type(() =>
   * Boolean)` turns the *string* "false" into `true`, so the endpoint reported
   * posting rows it had silently skipped. Hence this test, and `ToBoolean`.
   */
  test('preview=false restores a lost entry and the balance reconciles', async () => {
    // Simulate a post that never happened — a bug, a partial restore — by
    // removing one entry from under a record that still exists.
    const expense = await as(admin).post('/api/expenses', {
      date: '2026-08-24',
      amount: '640.00',
      description: 'Lost posting',
      expenseCategoryId: await categoryId(),
    });
    const reference = `EXP-${expense.body.id}`;

    const balanceWithIt = Number(await ledgerBalance());
    await query(`DELETE FROM ledger_entries WHERE reference = $1`, [reference]);
    assert.equal(
      Number(await ledgerBalance()),
      balanceWithIt + 640,
      'the balance is now wrong by exactly the missing debit',
    );

    const preview = await as(admin).post('/api/ledger/rebuild?preview=true');
    assert.equal(preview.body.preview, true);
    assert.equal(preview.body.posted.expenses, 1, 'preview must see the gap');
    assert.equal(
      (
        await query(`SELECT id FROM ledger_entries WHERE reference = $1`, [
          reference,
        ])
      ).length,
      0,
      'preview must not write',
    );

    const real = await as(admin).post('/api/ledger/rebuild?preview=false');
    assert.equal(real.body.preview, false);
    assert.equal(real.body.posted.expenses, 1);

    const restored = await query<{ amount: string }>(
      `SELECT amount::text FROM ledger_entries WHERE reference = $1`,
      [reference],
    );
    assert.equal(restored.length, 1);
    assert.equal(restored[0].amount, '640.00');
    assert.equal(Number(await ledgerBalance()), balanceWithIt);
  });

  /** BR-39 — ON CONFLICT DO NOTHING makes a rebuild a reconciliation. */
  test('BR-39 running it again posts nothing', async () => {
    await as(admin).post('/api/ledger/rebuild?preview=false');
    const r = await as(admin).post('/api/ledger/rebuild?preview=false');
    assert.deepEqual(r.body.posted, {
      salePayments: 0,
      expenses: 0,
      supplierPayments: 0,
    });
  });

  test('the balance equals the records behind it', async () => {
    const rows = await query<{
      balance: string;
      credits: string;
      debits: string;
      expenses: string;
    }>(
      `SELECT
         (SELECT COALESCE(SUM(e.amount * t.direction), 0)::text
            FROM ledger_entries e JOIN ledger_entry_types t ON t.id = e.entry_type_id) AS balance,
         (SELECT COALESCE(SUM(amount), 0)::text FROM sale_payments) AS credits,
         (SELECT COALESCE(SUM(amount), 0)::text FROM supplier_purchase_payments) AS debits,
         (SELECT COALESCE(SUM(amount), 0)::text FROM expenses) AS expenses`,
    );
    const { balance, credits, debits, expenses } = rows[0];
    assert.equal(
      Number(balance),
      Number(credits) - Number(debits) - Number(expenses),
    );
  });
});

/**
 * The bug that `?preview=false` exposed applies to every boolean query
 * parameter, so it is asserted where it is most visible.
 */
describe('boolean query parameters', () => {
  test('"false" means false, not truthy', async () => {
    const inactive = await as(admin).get('/api/shops?isActive=false');
    assert.ok(
      inactive.body.items.every(
        (s: { is_active: boolean }) => s.is_active === false,
      ),
    );

    const active = await as(admin).get('/api/shops?isActive=true');
    assert.ok(
      active.body.items.every(
        (s: { is_active: boolean }) => s.is_active === true,
      ),
    );
  });

  test('an unrecognised value is rejected, not guessed', async () => {
    const r = await as(admin).get('/api/shops?isActive=maybe');
    assert.equal(r.status, 400);
  });
});
