/**
 * Phase 2 end-to-end: the HTTP surface of authentication and authorisation.
 *
 * Runs under `node --test` because it boots the real application, which imports
 * better-auth (ESM) — see auth.test.ts for why Jest cannot.
 */
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import 'dotenv/config';
import type { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import type { Server } from 'node:http';
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
  throw new Error('DATABASE_URL_TEST must be set to run the API suite.');
}

let app: NestExpressApplication;
let server: Server;

const ORIGIN = process.env.BETTER_AUTH_URL ?? 'http://localhost:3000';

/** Sign in and return the session cookie. */
async function signIn(username: string, password: string): Promise<string> {
  const response = await request(server)
    .post('/api/auth/sign-in/username')
    .set('Origin', ORIGIN)
    .send({ username, password });

  assert.equal(response.status, 200, `sign-in failed for ${username}`);
  const cookies = response.headers['set-cookie'] as unknown as string[];
  return cookies.map((c) => c.split(';')[0]).join('; ');
}

async function seedStaff(
  username: string,
  typeCode: string,
  password: string,
): Promise<string> {
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
  return rows[0].id;
}

const OWNER_PW = 'Owner-Pass-123';
const EMPLOYEE_PW = 'Employee-Pass-123';
const MANAGER_PW = 'Manager-Pass-123';
let ownerCookie: string;
let employeeCookie: string;
let managerCookie: string;
let employeeId: string;

before(async () => {
  await migrateTestDatabase();
  await loadFixture();
  await seedStaff('e2eowner', 'owner', OWNER_PW);
  await seedStaff('e2emgr', 'manager', MANAGER_PW);
  employeeId = await seedStaff('e2estaff', 'employee', EMPLOYEE_PW);

  app = await createApp();
  await app.init();
  server = app.getHttpServer();

  ownerCookie = await signIn('e2eowner', OWNER_PW);
  managerCookie = await signIn('e2emgr', MANAGER_PW);
  employeeCookie = await signIn('e2estaff', EMPLOYEE_PW);
});

after(async () => {
  await app.close();
  await closePool();
  await authPool.end();
});

describe('FR-00.1 authentication is required', () => {
  test('the health probe is the one anonymous route', async () => {
    const response = await request(server).get('/api/health');
    assert.equal(response.status, 200);
    assert.equal(response.body.status, 'ok');
  });

  test('refuses an unauthenticated request', async () => {
    const response = await request(server).get('/api/me');
    assert.equal(response.status, 401);
  });

  test('refuses a forged session cookie', async () => {
    const response = await request(server)
      .get('/api/me')
      .set('Cookie', 'better-auth.session_token=not-a-real-token');
    assert.equal(response.status, 401);
  });
});

describe('/api/me', () => {
  test('BR-56 reports privilege from the user type', async () => {
    const response = await request(server)
      .get('/api/me')
      .set('Cookie', ownerCookie);
    assert.equal(response.status, 200);
    assert.equal(response.body.username, 'e2eowner');
    assert.equal(response.body.userType.code, 'owner');
    assert.equal(response.body.userType.isSuperuser, true);
    assert.equal(response.body.userType.isManager, true);
  });

  /** FR-00.3 — the client needs these to hide menus it cannot open. */
  test('returns the permission set the type grants', async () => {
    const response = await request(server)
      .get('/api/me')
      .set('Cookie', employeeCookie);
    assert.equal(response.body.userType.code, 'employee');
    assert.equal(response.body.userType.isSuperuser, false);
    assert.ok(response.body.permissions.includes('add_sale'));
    assert.ok(!response.body.permissions.includes('view_user'));
  });
});

describe('§10.3 permissions gate every route', () => {
  test('an employee without view_user is refused the staff list', async () => {
    const response = await request(server)
      .get('/api/users')
      .set('Cookie', employeeCookie);
    assert.equal(response.status, 403);
    assert.match(response.body.message, /view_user/);
  });

  test('an owner may read it', async () => {
    const response = await request(server)
      .get('/api/users')
      .set('Cookie', ownerCookie);
    assert.equal(response.status, 200);
    assert.ok(Array.isArray(response.body.items));
    // RD-12 — every list view is paginated.
    assert.equal(response.body.pageSize, 10);
  });

  test('BR-41 deletion is restricted to unrestricted accounts', async () => {
    const response = await request(server)
      .delete('/api/users/999999')
      .set('Cookie', employeeCookie);
    assert.equal(response.status, 403);
  });

  test('a missing record is 404, not a silent success', async () => {
    const response = await request(server)
      .delete('/api/users/999999')
      .set('Cookie', ownerCookie);
    assert.equal(response.status, 404);
  });
});

describe('FR-00.6 creating a staff account', () => {
  test('generates an employee ID and keeps money exact', async () => {
    const response = await request(server)
      .post('/api/users')
      .set('Cookie', ownerCookie)
      .send({
        username: 'e2enew',
        password: 'Brand-New-Pass-1',
        name: 'Brand New',
        userTypeId: '2',
        salary: '45000.50',
        joinDate: '2026-01-15',
      });

    assert.equal(response.status, 201);
    // FR-00.8 — generated, never supplied by the caller.
    assert.match(response.body.employee_id, /^EMP-[0-9A-F]{8}$/);
    // NFR-01 — a decimal string, never a float.
    assert.equal(response.body.salary, '45000.50');
    assert.equal(response.body.user_type_code, 'manager');
    assert.equal(response.body.status_code, 'active');
  });

  /**
   * Migration 016's audit columns are only worth having if something fills
   * them. The acting user comes from the session, never from the request body.
   */
  test('records who created the account', async () => {
    const rows = await query<{
      created_by_id: string | null;
      updated_by_id: string | null;
      username: string;
    }>(
      `SELECT u.created_by_id::text, u.updated_by_id::text, actor.username
         FROM users u JOIN users actor ON actor.id = u.created_by_id
        WHERE u.username = 'e2enew'`,
    );
    assert.equal(rows.length, 1);
    assert.equal(rows[0].username, 'e2eowner');
    assert.equal(rows[0].created_by_id, rows[0].updated_by_id);
  });

  test('records who last changed it, and the database stamps updated_at', async () => {
    const before = await query<{ updated_at: string }>(
      `SELECT updated_at FROM users WHERE username = 'e2enew'`,
    );

    const response = await request(server)
      .patch(
        `/api/users/${
          (
            await query<{ id: string }>(
              `SELECT id::text FROM users WHERE username = 'e2enew'`,
            )
          )[0].id
        }`,
      )
      .set('Cookie', ownerCookie)
      .send({ phone: '01799000000' });
    assert.equal(response.status, 200);

    const after = await query<{ updated_at: string; actor: string }>(
      `SELECT u.updated_at, actor.username AS actor
         FROM users u JOIN users actor ON actor.id = u.updated_by_id
        WHERE u.username = 'e2enew'`,
    );
    assert.equal(after[0].actor, 'e2eowner');
    // Set by trg_users_touch, not by the service layer.
    assert.ok(
      new Date(after[0].updated_at).getTime() >
        new Date(before[0].updated_at).getTime(),
    );
  });

  test('the new account can sign in immediately', async () => {
    const cookie = await signIn('e2enew', 'Brand-New-Pass-1');
    const response = await request(server).get('/api/me').set('Cookie', cookie);
    assert.equal(response.status, 200);
    assert.equal(response.body.username, 'e2enew');
  });

  /**
   * The row and its credential are one transaction. A duplicate username fails
   * at the users insert, so nothing at all should be written — in particular no
   * orphan in `accounts`.
   */
  test('rolls the whole thing back on a duplicate username', async () => {
    const before = await query<{ n: string }>(
      `SELECT count(*)::text AS n FROM accounts`,
    );

    const response = await request(server)
      .post('/api/users')
      .set('Cookie', ownerCookie)
      .send({
        username: 'e2enew',
        password: 'Another-Pass-1',
        name: 'Duplicate',
        userTypeId: '2',
      });

    assert.equal(response.status, 409);
    assert.match(response.body.message, /username/i);

    const after = await query<{ n: string }>(
      `SELECT count(*)::text AS n FROM accounts`,
    );
    assert.equal(
      after[0].n,
      before[0].n,
      'an orphan account row was left behind',
    );
  });

  test('rejects a password shorter than the policy allows', async () => {
    const response = await request(server)
      .post('/api/users')
      .set('Cookie', ownerCookie)
      .send({
        username: 'e2eshort',
        password: 'short',
        name: 'Short',
        userTypeId: '2',
      });
    assert.equal(response.status, 400);
  });

  /** BR-57 — every account has exactly one type; there is no untyped account. */
  test('refuses an account with no user type', async () => {
    const response = await request(server)
      .post('/api/users')
      .set('Cookie', ownerCookie)
      .send({
        username: 'e2enotype',
        password: 'Some-Pass-123',
        name: 'No Type',
      });
    assert.equal(response.status, 400);
  });
});

describe('password changes', () => {
  test('a staff member may change their own', async () => {
    const response = await request(server)
      .post(`/api/users/${employeeId}/password`)
      .set('Cookie', employeeCookie)
      .send({ password: 'Employee-New-Pass-1' });
    assert.equal(response.status, 204);

    await signIn('e2estaff', 'Employee-New-Pass-1');
    employeeCookie = await signIn('e2estaff', 'Employee-New-Pass-1');
  });

  test('but not someone else’s without change_user', async () => {
    const response = await request(server)
      .post('/api/users/1/password')
      .set('Cookie', employeeCookie)
      .send({ password: 'Trying-It-On-123' });
    assert.equal(response.status, 403);
  });
});

/**
 * FR-00.8 and BR-56 — what the update endpoint must refuse to touch.
 * `forbidNonWhitelisted` on the global pipe turns an unknown field into a 400
 * rather than quietly ignoring it, which is what makes this assertable.
 */
describe('immutable and non-existent fields', () => {
  for (const [field, value] of [
    ['employeeId', 'EMP-HACKED1'],
    ['username', 'renamed'],
    ['isSuperuser', true],
    ['isManager', true],
  ] as Array<[string, unknown]>) {
    test(`refuses to set ${field}`, async () => {
      const response = await request(server)
        .patch(`/api/users/${employeeId}`)
        .set('Cookie', ownerCookie)
        .send({ [field]: value });
      assert.equal(response.status, 400);
    });
  }
});

/**
 * What a referential failure looks like from the client's side.
 *
 * Reported from Postman: `POST /api/customers` with a `shopId` no shop has
 * came back 409 *"still referenced by other records … Deactivate it instead of
 * deleting it"* — the advice for deleting a row that is in use, which is the
 * opposite of what happened. One constraint covers both directions and the
 * message only described one. The schema suite proves the derivation against
 * PostgreSQL; this proves the wiring reaches the response.
 */
describe('referential errors read as validation, not as deletion advice', () => {
  test('a shopId matching no shop names the shop and the field', async () => {
    const response = await request(server)
      .post('/api/customers')
      .set('Cookie', ownerCookie)
      .send({ name: 'Niren Costa', phone: '01548593022', shopId: '999999' });

    assert.equal(response.status, 422);
    assert.equal(
      response.body.message,
      'That shop does not exist. Check the "shopId" value.',
    );
    assert.equal(response.body.constraint, 'customers_shop_id_fkey');
    // The old message pointed the user at the wrong remedy entirely.
    assert.doesNotMatch(response.body.message, /Deactivate/);
  });

  test('so does a customerId matching no customer', async () => {
    const response = await request(server)
      .post('/api/sales')
      .set('Cookie', ownerCookie)
      .send({
        customerId: '999999',
        shopId: '1',
        items: [
          {
            itemType: 'non_inventory',
            description: 'Tailoring',
            quantity: '1',
            unitPrice: '100',
          },
        ],
      });

    assert.equal(response.status, 422);
    assert.equal(
      response.body.message,
      'That customer does not exist. Check the "customerId" value.',
    );
  });

  /**
   * A constraint with a message of its own keeps it — and keeps its status.
   * BR-53 is not "no such customer", it is "not *this shop's* customer", and
   * only the named entry can say so.
   */
  test('a named constraint still wins over the derived sentence', async () => {
    const other = await query<{ id: string }>(
      `SELECT id::text FROM customers WHERE shop_id = 2 LIMIT 1`,
    );
    const response = await request(server)
      .post('/api/sales')
      .set('Cookie', ownerCookie)
      .send({
        customerId: other[0].id,
        shopId: '1',
        items: [
          {
            itemType: 'non_inventory',
            description: 'Tailoring',
            quantity: '1',
            unitPrice: '100',
          },
        ],
      });

    assert.equal(response.status, 409);
    assert.equal(response.body.constraint, 'fk_sale_customer_shop');
    assert.equal(
      response.body.message,
      'The customer must belong to the same shop as the sale.',
    );
  });
});

/**
 * FR-00.4 — roles are containers for permissions, granted and revoked per role.
 *
 * This suite is LAST on purpose. The happy path changes what the employee type
 * confers, which is exactly the point of BR-56 — and it would otherwise pull the
 * rug out from under the `§10.3 permissions gate every route` cases above, which
 * assert that an employee is refused the staff list.
 */
describe('FR-00.4 editing what a role grants', () => {
  let employeeTypeId = '';
  let ownerTypeId = '';
  let seeded: string[] = [];
  const path = (id: string) => `/api/users/types/${id}/permissions`;

  before(async () => {
    const rows = await query<{ id: string; code: string }>(
      `SELECT id::text, code FROM user_types WHERE code IN ('employee', 'owner')`,
    );
    employeeTypeId = rows.find((r) => r.code === 'employee')!.id;
    ownerTypeId = rows.find((r) => r.code === 'owner')!.id;
    seeded = (
      await query<{ codename: string }>(
        `SELECT p.codename FROM user_type_permissions utp
           JOIN permissions p ON p.id = utp.permission_id
          WHERE utp.user_type_id = $1`,
        [employeeTypeId],
      )
    ).map((r) => r.codename);
    process.env.ENABLE_ROLE_EDITING = 'true';
  });

  /*
   * Put the employee type back however the run ended.
   *
   * `loadFixture()` does not reset `user_type_permissions` — the grants come
   * from the seed migration — so a test that failed part-way through the happy
   * path would leave `view_user` granted, and every later run of this file
   * would start in a world where the cases above ("an employee is refused the
   * staff list") are false. That is not hypothetical; it happened.
   */
  after(async () => {
    delete process.env.ENABLE_ROLE_EDITING;
    await query(`DELETE FROM user_type_permissions WHERE user_type_id = $1`, [
      employeeTypeId,
    ]);
    if (seeded.length > 0) {
      await query(
        `INSERT INTO user_type_permissions (user_type_id, permission_id)
           SELECT $1, p.id FROM permissions p WHERE p.codename = ANY($2)`,
        [employeeTypeId, seeded],
      );
    }
  });

  test('an employee cannot edit grants', async () => {
    const r = await request(server)
      .put(path(employeeTypeId))
      .set('Cookie', employeeCookie)
      .send({ permissions: ['view_user'] });
    assert.equal(r.status, 403);
  });

  /** The point of restricting this to unrestricted accounts: a manager holds
   *  `manage_referencedata`, and without the superuser gate could grant
   *  themselves the two things their own role deliberately withholds. */
  test('a manager cannot edit grants either', async () => {
    const r = await request(server)
      .put(path(employeeTypeId))
      .set('Cookie', managerCookie)
      .send({ permissions: ['view_user'] });
    assert.equal(r.status, 403);
  });

  test('BR-42-style: refused unless deliberately enabled', async () => {
    delete process.env.ENABLE_ROLE_EDITING;
    const r = await request(server)
      .put(path(employeeTypeId))
      .set('Cookie', ownerCookie)
      .send({ permissions: ['view_user'] });
    process.env.ENABLE_ROLE_EDITING = 'true';

    assert.equal(r.status, 403);
    assert.match(r.body.message, /ENABLE_ROLE_EDITING/);
  });

  /**
   * An unrestricted type passes every check through `is_superuser`, so editing
   * its list would change nothing while appearing to. Note this also covers
   * "you cannot edit your own role" for every caller who can reach this route:
   * only a superuser may, and a superuser's own type is by definition
   * unrestricted, so this refusal fires first. The own-role check in the service
   * is defence for a future in which the guard is widened.
   */
  test('an unrestricted role cannot be edited', async () => {
    const r = await request(server)
      .put(path(ownerTypeId))
      .set('Cookie', ownerCookie)
      .send({ permissions: ['view_user'] });
    assert.equal(r.status, 403);
    assert.match(r.body.message, /unrestricted/i);
  });

  test('an unknown codename is refused by name, never dropped', async () => {
    const r = await request(server)
      .put(path(employeeTypeId))
      .set('Cookie', ownerCookie)
      .send({ permissions: ['view_sale', 'view_everything'] });
    assert.equal(r.status, 400);
    assert.match(r.body.message, /view_everything/);
  });

  test('an unknown user type is 404', async () => {
    const r = await request(server)
      .put(path('999999'))
      .set('Cookie', ownerCookie)
      .send({ permissions: [] });
    assert.equal(r.status, 404);
  });

  /** A `bigint` column: without a shape check this is a query error, not a 404. */
  test('a non-numeric type id is 404, not a 500', async () => {
    const r = await request(server)
      .get(path('abc'))
      .set('Cookie', ownerCookie);
    assert.equal(r.status, 404);
  });

  test('the read endpoint 404s on an unknown type too', async () => {
    const r = await request(server)
      .get(path('999999'))
      .set('Cookie', ownerCookie);
    assert.equal(r.status, 404);
  });

  /**
   * The escalation this closes, as a regression test.
   *
   * A manager holds `manage_referencedata` AND `change_user`. Before these two
   * refusals they could mint an unrestricted type and step into it in two
   * requests, going from manager to full administrator without anyone granting
   * them anything. Both halves are asserted, because either one alone leaves
   * the door open.
   */
  test('a manager cannot mint an unrestricted role', async () => {
    const r = await request(server)
      .post('/api/reference/user-types')
      .set('Cookie', managerCookie)
      .send({ code: 'escalated', label: 'Escalated', isSuperuser: true });

    assert.equal(r.status, 403);
    assert.match(r.body.message, /administrators/i);

    const created = await query<{ id: string }>(
      `SELECT id::text FROM user_types WHERE code = 'escalated'`,
    );
    assert.equal(created.length, 0, 'nothing was written');
  });

  test('a manager cannot promote an existing role either', async () => {
    const r = await request(server)
      .patch(`/api/reference/user-types/${employeeTypeId}`)
      .set('Cookie', managerCookie)
      .send({ isManager: true });
    assert.equal(r.status, 403);
  });

  test('nobody may re-point their own account at another role', async () => {
    const me = await request(server).get('/api/me').set('Cookie', ownerCookie);
    const r = await request(server)
      .patch(`/api/users/${me.body.id}`)
      .set('Cookie', ownerCookie)
      .send({ userTypeId: employeeTypeId });

    assert.equal(r.status, 403);
    assert.match(r.body.message, /your own role/i);

    // Still an owner.
    const after_ = await request(server).get('/api/me').set('Cookie', ownerCookie);
    assert.equal(after_.body.userType.isSuperuser, true);
  });

  /**
   * BR-60 — an entry "in use" cannot be deleted, but its own permission grants
   * are not usage. A role nobody holds used to refuse deletion, reporting its
   * own grants as the records using it.
   */
  test('a role holding grants but no accounts can still be deleted', async () => {
    const created = await request(server)
      .post('/api/reference/user-types')
      .set('Cookie', ownerCookie)
      .send({ code: 'temprole', label: 'Temp role' });
    assert.equal(created.status, 201);
    const tempId: string = created.body.id;

    const granted = await request(server)
      .put(path(tempId))
      .set('Cookie', ownerCookie)
      .send({ permissions: ['view_sale', 'view_customer'] });
    assert.equal(granted.status, 200);

    const usage = await request(server)
      .get(`/api/reference/user-types/${tempId}/usage`)
      .set('Cookie', ownerCookie);
    assert.equal(usage.body.total, 0, 'its own grants are not usage');

    const removed = await request(server)
      .delete(`/api/reference/user-types/${tempId}`)
      .set('Cookie', ownerCookie);
    assert.equal(removed.status, 204);

    // The grants went with it, by ON DELETE CASCADE.
    const left = await query(
      `SELECT 1 FROM user_type_permissions WHERE user_type_id = $1`,
      [tempId],
    );
    assert.equal(left.length, 0);
  });

  /**
   * FR-00.2 mechanism 2 — one menu permission per sidebar entry.
   *
   * The migration that added the last seven had one job beyond creating them:
   * change nobody's sidebar. So the assertion is who holds them, not that they
   * exist.
   */
  test('every navigation entry has a menu permission of its own', async () => {
    const r = await request(server)
      .get(path(employeeTypeId))
      .set('Cookie', ownerCookie);

    const menu = r.body.catalogue
      .filter((p: { module: string }) => p.module === 'menu')
      .map((p: { codename: string }) => p.codename)
      .sort();

    assert.deepEqual(menu, [
      'view_bills_menu',
      'view_categories_menu',
      'view_customers_menu',
      'view_departments_menu',
      'view_expenses_menu',
      'view_inventory_menu',
      'view_job_positions_menu',
      'view_reports_menu',
      'view_review_bills_menu',
      'view_roles_menu',
      'view_sales_menu',
      'view_shops_menu',
      'view_suppliers_menu',
      'view_users_menu',
    ]);

    // No sidebar entry may be gated on a record permission any more, so the
    // menu permissions have to outnumber what the old arrangement covered.
    assert.equal(menu.length, 14);
  });

  test('the new menu permissions leave every sidebar exactly as it was', async () => {
    const held = async (typeCode: string) => {
      const rows = await query<{ codename: string }>(
        `SELECT p.codename FROM user_type_permissions utp
           JOIN permissions p ON p.id = utp.permission_id
           JOIN user_types t ON t.id = utp.user_type_id
          WHERE t.code = $1 AND p.module = 'menu'`,
        [typeCode],
      );
      return new Set(rows.map((row) => row.codename));
    };

    const [owner, manager, finance, employee] = await Promise.all([
      held('owner'),
      held('manager'),
      held('finance'),
      held('employee'),
    ]);

    // My bills was visible to all four, and still is.
    for (const [name, set] of [
      ['owner', owner],
      ['manager', manager],
      ['finance', finance],
      ['employee', employee],
    ] as const) {
      assert.ok(set.has('view_bills_menu'), `${name} keeps My bills`);
    }

    // Review bills, Users and the reference screens were owner + manager only.
    for (const codename of [
      'view_review_bills_menu',
      'view_users_menu',
      'view_categories_menu',
      'view_job_positions_menu',
      'view_departments_menu',
    ]) {
      assert.ok(owner.has(codename), `owner keeps ${codename}`);
      assert.ok(manager.has(codename), `manager keeps ${codename}`);
      assert.ok(!finance.has(codename), `finance still lacks ${codename}`);
      assert.ok(!employee.has(codename), `employee still lacks ${codename}`);
    }

    // Roles & permissions is administrator-only.
    assert.ok(owner.has('view_roles_menu'));
    assert.ok(!manager.has('view_roles_menu'));

    // Finance held view_reports_menu but has never seen Reports — the entry and
    // the page are both manager-only. A grant that does nothing is a grant that
    // misleads, so the migration removes it.
    assert.ok(!finance.has('view_reports_menu'));
  });

  /**
   * BR-56, and the whole reason this endpoint exists — the permission set is
   * cached per user type, so a write that did not drop the cache would take
   * effect only after a restart. The assertion is made on a session that was
   * signed in BEFORE the change, with no restart in between.
   */
  test('BR-56 a granted permission reaches live sessions immediately', async () => {
    const before_ = await request(server)
      .get('/api/users')
      .set('Cookie', employeeCookie);
    assert.equal(before_.status, 403, 'an employee starts without view_user');

    const current = await request(server)
      .get(path(employeeTypeId))
      .set('Cookie', ownerCookie);
    assert.equal(current.status, 200);
    const original: string[] = current.body.granted;
    assert.deepEqual(original, [...seeded].sort(), 'starts from the seeded set');

    const granted = await request(server)
      .put(path(employeeTypeId))
      .set('Cookie', ownerCookie)
      .send({ permissions: [...original, 'view_user'] });
    assert.equal(granted.status, 200);
    assert.ok(granted.body.granted.includes('view_user'));

    // No restart, same cookie.
    const after_ = await request(server)
      .get('/api/users')
      .set('Cookie', employeeCookie);
    assert.equal(after_.status, 200, 'the grant took effect immediately');

    // And revoking is seen just as fast.
    const revoked = await request(server)
      .put(path(employeeTypeId))
      .set('Cookie', ownerCookie)
      .send({ permissions: original });
    assert.equal(revoked.status, 200);
    assert.deepEqual(revoked.body.granted, original);

    const restored = await request(server)
      .get('/api/users')
      .set('Cookie', employeeCookie);
    assert.equal(restored.status, 403, 'the revoke took effect immediately');
  });
});
