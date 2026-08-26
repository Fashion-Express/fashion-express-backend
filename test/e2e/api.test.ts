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
let ownerCookie: string;
let employeeCookie: string;
let employeeId: string;

before(async () => {
  await migrateTestDatabase();
  await loadFixture();
  await seedStaff('e2eowner', 'owner', OWNER_PW);
  employeeId = await seedStaff('e2estaff', 'employee', EMPLOYEE_PW);

  app = await createApp();
  await app.init();
  server = app.getHttpServer() as Server;

  ownerCookie = await signIn('e2eowner', OWNER_PW);
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
