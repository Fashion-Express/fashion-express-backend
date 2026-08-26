/**
 * FR-12 — the twelve reference lists.
 *
 * The interesting cases are not "CRUD works" but the three tiers pulling in
 * different directions: a code that must never change (BR-59), an entry in use
 * that must not be deleted (BR-60), and the structural lists that accept a new
 * label and nothing else (BR-61, BR-66).
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
let owner: string;
let employee: string;

const ORIGIN = process.env.BETTER_AUTH_URL ?? 'http://localhost:3000';

async function signIn(username: string, password: string): Promise<string> {
  const response = await request(server)
    .post('/api/auth/sign-in/username')
    .set('Origin', ORIGIN)
    .send({ username, password });
  assert.equal(response.status, 200, `sign-in failed for ${username}`);
  const cookies = response.headers['set-cookie'] as unknown as string[];
  return cookies.map((c) => c.split(';')[0]).join('; ');
}

async function seedStaff(username: string, typeCode: string, password: string) {
  const rows = await query<{ id: string }>(
    `INSERT INTO users (username, display_username, name, email, employee_id,
                        user_type_id, status_id, shop_id)
     SELECT lower($1), $1, $1, $2, $3,
            (SELECT id FROM user_types WHERE code = $4),
            (SELECT id FROM statuses WHERE scope='user' AND code='active'), 1
     RETURNING id::text`,
    [username, `${username}@fe.test`, `EMP-${username}`, typeCode],
  );
  await createCredential(rows[0].id, password);
}

async function unitId(code: string): Promise<string> {
  const rows = await query<{ id: string }>(
    `SELECT id::text FROM units WHERE code = $1`,
    [code],
  );
  return rows[0].id;
}

before(async () => {
  await migrateTestDatabase();
  await loadFixture();
  await seedStaff('refowner', 'owner', 'Ref-Owner-Pass-1');
  await seedStaff('refstaff', 'employee', 'Ref-Staff-Pass-1');

  app = await createApp();
  await app.init();
  server = app.getHttpServer() as Server;

  owner = await signIn('refowner', 'Ref-Owner-Pass-1');
  employee = await signIn('refstaff', 'Ref-Staff-Pass-1');
});

after(async () => {
  await app.close();
  await closePool();
  await authPool.end();
});

describe('the catalogue', () => {
  test('lists all twelve vocabularies', async () => {
    const response = await request(server)
      .get('/api/reference')
      .set('Cookie', owner);
    assert.equal(response.status, 200);
    assert.equal(response.body.length, 12);
  });

  /** FR-12.5.2 — the client should not hard-code which lists are structural. */
  test('reports per-list capabilities so the UI can hide Add and Delete', async () => {
    const response = await request(server)
      .get('/api/reference')
      .set('Cookie', owner);
    const bySlug = Object.fromEntries(
      response.body.map((l: Record<string, unknown>) => [l.slug, l]),
    );

    for (const slug of [
      'transaction-types',
      'ledger-entry-types',
      'ledger-sources',
    ]) {
      assert.equal(bySlug[slug].kind, 'structural', slug);
      assert.equal(bySlug[slug].create, false, slug);
      assert.equal(bySlug[slug].delete, false, slug);
      assert.deepEqual(bySlug[slug].editableFields, ['label'], slug);
    }

    assert.equal(bySlug['units'].create, true);
    assert.equal(bySlug['units'].delete, true);
    // The code never appears as editable, on any list (BR-59).
    for (const list of response.body) {
      assert.ok(!list.editableFields.includes('code'), list.slug);
    }
  });

  test('404s an unknown list rather than reaching for a table', async () => {
    const response = await request(server)
      .get('/api/reference/pg_user')
      .set('Cookie', owner);
    assert.equal(response.status, 404);
  });
});

describe('reading', () => {
  test('paginates at 25 (RD-12)', async () => {
    const response = await request(server)
      .get('/api/reference/units')
      .set('Cookie', owner);
    assert.equal(response.body.pageSize, 25);
    assert.equal(response.body.total, 5);
  });

  test('a scoped list can be filtered to one scope', async () => {
    const response = await request(server)
      .get('/api/reference/statuses?scope=claim')
      .set('Cookie', owner);
    assert.deepEqual(
      response.body.items.map((r: { code: string }) => r.code).sort(),
      ['approved', 'pending', 'rejected'],
    );
  });

  test('rejects an unknown scope', async () => {
    const response = await request(server)
      .get('/api/reference/statuses?scope=nonsense')
      .set('Cookie', owner);
    assert.equal(response.status, 400);
  });

  /**
   * BR-62 — an unfiltered picker on a scoped list would offer LC on a customer
   * receipt, which the database then refuses: a confusing error for something
   * the UI should never have shown.
   */
  test('a picker on a scoped list must name its scope', async () => {
    const unscoped = await request(server)
      .get('/api/reference/payment-methods/options')
      .set('Cookie', owner);
    assert.equal(unscoped.status, 400);

    const scoped = await request(server)
      .get('/api/reference/payment-methods/options?scope=supplier')
      .set('Cookie', owner);
    assert.deepEqual(
      scoped.body.map((r: { code: string }) => r.code),
      ['lc', 'check', 'tt', 'cash', 'bank'],
    );
    // And never a customer method.
    assert.ok(!scoped.body.some((r: { code: string }) => r.code === 'cheque'));
  });
});

describe('BR-59 the code is fixed once created', () => {
  test('refuses an attempt to edit it', async () => {
    const response = await request(server)
      .patch(`/api/reference/units/${await unitId('pcs')}`)
      .set('Cookie', owner)
      .send({ code: 'piece' });
    assert.equal(response.status, 400);
  });

  test('but the label is freely editable', async () => {
    const id = await unitId('pcs');
    const response = await request(server)
      .patch(`/api/reference/units/${id}`)
      .set('Cookie', owner)
      .send({ label: 'Units' });
    assert.equal(response.status, 200);
    assert.equal(response.body.label, 'Units');
    assert.equal(response.body.code, 'pcs', 'the code must be untouched');

    await request(server)
      .patch(`/api/reference/units/${id}`)
      .set('Cookie', owner)
      .send({ label: 'Pieces' });
  });

  test('rejects a code that would break the database’s own shape rule', async () => {
    const response = await request(server)
      .post('/api/reference/units')
      .set('Cookie', owner)
      .send({ code: 'Sq Ft', label: 'Square Feet' });
    assert.equal(response.status, 400);
    assert.match(String(response.body.message), /lower-case/);
  });
});

describe('BR-60 an entry in use cannot be deleted', () => {
  test('reports what uses it, before anything is attempted', async () => {
    // The fixture stocks the same product in both shops (BR-51 permits the same
    // part_code per shop), so `pcs` is referenced more than once. Read the real
    // count rather than hard-coding it.
    const expected = await query<{ n: string }>(
      `SELECT count(*)::text AS n FROM inventory_items
        WHERE unit_id = (SELECT id FROM units WHERE code = 'pcs')`,
    );

    const response = await request(server)
      .get(`/api/reference/units/${await unitId('pcs')}/usage`)
      .set('Cookie', owner);
    assert.equal(response.status, 200);
    assert.equal(response.body.total, Number(expected[0].n));
    assert.equal(
      response.body.byTable['inventory_items.unit_id'],
      Number(expected[0].n),
    );
  });

  test('refuses the delete and says what to do instead', async () => {
    const response = await request(server)
      .delete(`/api/reference/units/${await unitId('pcs')}`)
      .set('Cookie', owner);
    assert.equal(response.status, 409);
    assert.match(response.body.message, /Deactivate it instead/);
  });

  /**
   * The point of BR-60: deactivating hides the entry from pickers while every
   * existing record keeps its meaning (§23.6). Filtering `is_active` in the
   * wrong place would make those records look broken.
   */
  test('deactivating hides it from pickers but not from reads', async () => {
    const id = await unitId('pcs');
    await request(server)
      .patch(`/api/reference/units/${id}`)
      .set('Cookie', owner)
      .send({ isActive: false });

    const options = await request(server)
      .get('/api/reference/units/options')
      .set('Cookie', owner);
    assert.ok(!options.body.some((r: { code: string }) => r.code === 'pcs'));

    const list = await request(server)
      .get('/api/reference/units')
      .set('Cookie', owner);
    assert.ok(list.body.items.some((r: { code: string }) => r.code === 'pcs'));

    await request(server)
      .patch(`/api/reference/units/${id}`)
      .set('Cookie', owner)
      .send({ isActive: true });
  });

  test('an unused entry deletes cleanly', async () => {
    const created = await request(server)
      .post('/api/reference/units')
      .set('Cookie', owner)
      .send({ code: 'sqft', label: 'Square Feet', sortOrder: 6 });
    assert.equal(created.status, 201);

    const usage = await request(server)
      .get(`/api/reference/units/${created.body.id}/usage`)
      .set('Cookie', owner);
    assert.equal(usage.body.total, 0);

    const deleted = await request(server)
      .delete(`/api/reference/units/${created.body.id}`)
      .set('Cookie', owner);
    assert.equal(deleted.status, 204);
  });

  test('a duplicate code is refused by the database', async () => {
    const response = await request(server)
      .post('/api/reference/units')
      .set('Cookie', owner)
      .send({ code: 'pcs', label: 'Duplicate' });
    assert.equal(response.status, 409);
    assert.equal(response.body.constraint, 'uq_units_code');
  });
});

describe('BR-61 / BR-66 structural lists', () => {
  for (const slug of [
    'transaction-types',
    'ledger-entry-types',
    'ledger-sources',
  ]) {
    test(`${slug} refuses a new entry`, async () => {
      const response = await request(server)
        .post(`/api/reference/${slug}`)
        .set('Cookie', owner)
        .send({ code: 'invented', label: 'Invented' });
      assert.equal(response.status, 400);
      assert.match(response.body.message, /structural/);
    });

    test(`${slug} refuses a delete`, async () => {
      const rows = await query<{ id: string }>(
        `SELECT id::text FROM ${slug.replace(/-/g, '_')} ORDER BY id LIMIT 1`,
      );
      const response = await request(server)
        .delete(`/api/reference/${slug}/${rows[0].id}`)
        .set('Cookie', owner);
      assert.equal(response.status, 400);
    });
  }

  test('accepts a new label — that is the whole of what they allow', async () => {
    const rows = await query<{ id: string }>(
      `SELECT id::text FROM ledger_entry_types WHERE code = 'credit'`,
    );
    const response = await request(server)
      .patch(`/api/reference/ledger-entry-types/${rows[0].id}`)
      .set('Cookie', owner)
      .send({ label: 'Credit (CR)' });
    assert.equal(response.status, 200);
    assert.equal(response.body.label, 'Credit (CR)');
    // The direction is what the balance is computed from and is not negotiable.
    assert.equal(response.body.direction, 1);

    await request(server)
      .patch(`/api/reference/ledger-entry-types/${rows[0].id}`)
      .set('Cookie', owner)
      .send({ label: 'Credit' });
  });

  /**
   * Retiring `debit` is not something the business can sensibly do: every
   * ledger writer targets one of these entries, and the balance sums them all.
   */
  test('refuses deactivation, not just create and delete', async () => {
    const rows = await query<{ id: string }>(
      `SELECT id::text FROM ledger_entry_types WHERE code = 'debit'`,
    );
    const response = await request(server)
      .patch(`/api/reference/ledger-entry-types/${rows[0].id}`)
      .set('Cookie', owner)
      .send({ isActive: false });
    assert.equal(response.status, 400);
    assert.match(response.body.message, /only the label may be edited/);
  });
});

describe('scoped creation', () => {
  test('requires a scope on a scoped list', async () => {
    const response = await request(server)
      .post('/api/reference/payment-methods')
      .set('Cookie', owner)
      .send({ code: 'mobile', label: 'Mobile banking' });
    assert.equal(response.status, 400);
    assert.match(response.body.message, /scope is required/);
  });

  test('refuses a scope on an unscoped list', async () => {
    const response = await request(server)
      .post('/api/reference/units')
      .set('Cookie', owner)
      .send({ code: 'dozen', label: 'Dozen', scope: 'customer' });
    assert.equal(response.status, 400);
  });

  /** FR-12.9.2 — a new supplier method is allowed, and BR-29 makes it fail safe. */
  test('accepts a new method in a named scope', async () => {
    const response = await request(server)
      .post('/api/reference/payment-methods')
      .set('Cookie', owner)
      .send({ code: 'mobile', label: 'Mobile banking', scope: 'supplier' });
    assert.equal(response.status, 201);
    assert.equal(response.body.scope, 'supplier');

    await request(server)
      .delete(`/api/reference/payment-methods/${response.body.id}`)
      .set('Cookie', owner);
  });
});

describe('permissions', () => {
  test('any signed-in user may read — pickers are day-to-day', async () => {
    const response = await request(server)
      .get('/api/reference/units/options')
      .set('Cookie', employee);
    assert.equal(response.status, 200);
  });

  test('writing needs manage_referencedata', async () => {
    // Each request is built inside the loop: supertest binds a port when the
    // request is created, so constructing them all up front fires three at once.
    const attempts: Array<() => Promise<{ status: number }>> = [
      () =>
        request(server)
          .post('/api/reference/units')
          .set('Cookie', employee)
          .send({ code: 'x', label: 'X' }),
      () =>
        request(server)
          .patch('/api/reference/units/1')
          .set('Cookie', employee)
          .send({ label: 'X' }),
      () =>
        request(server)
          .delete('/api/reference/units/1')
          .set('Cookie', employee),
    ];

    for (const attempt of attempts) {
      const response = await attempt();
      assert.equal(response.status, 403);
    }
  });

  test('and a session at all', async () => {
    const response = await request(server).get('/api/reference/units');
    assert.equal(response.status, 401);
  });
});
