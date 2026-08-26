/**
 * The identity layer's load-bearing assumption: better-auth can drive the
 * business `users` table — a bigint identity primary key, plus NOT NULL columns
 * it knows nothing about — rather than owning a table of its own. If this fails,
 * the mapping in src/config/auth.ts is wrong and every `created_by_id` in the
 * schema points at the wrong thing.
 *
 * **Why this suite does not run under Jest.** better-auth ships as ESM (`.mjs`),
 * and Jest decides a module's type from its extension before any transform
 * runs, so a `.mjs` dependency cannot be loaded by the CommonJS registry at all.
 * Getting Jest to load it means switching the whole project to Jest's
 * experimental ESM mode. Node's own test runner handles ESM natively and strips
 * TypeScript without a transform, so the auth tests use that and the SQL suites
 * stay on Jest.
 *
 *     npm run test:auth
 */
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import 'dotenv/config';
import { auth, authPool } from '../../src/config/auth';
import {
  createCredential,
  replaceCredential,
} from '../../src/modules/auth/credentials';
import {
  closePool,
  loadFixture,
  migrateTestDatabase,
  query,
} from '../schema/harness';

process.env.NODE_ENV = 'test';
if (!process.env.DATABASE_URL_TEST) {
  throw new Error('DATABASE_URL_TEST must be set to run the auth suite.');
}

const PASSWORD = 'correct-horse-battery';

async function provision(username: string): Promise<string> {
  const rows = await query<{ id: string }>(
    `INSERT INTO users (username, display_username, name, email, user_type_id, status_id, shop_id, employee_id)
     SELECT $1, $2, 'Test Staff', $3,
            (SELECT id FROM user_types WHERE code='owner'),
            (SELECT id FROM statuses WHERE scope='user' AND code='active'),
            1, $4
     RETURNING id`,
    [username, username, `${username}@fashionexpress.test`, `EMP-${username}`],
  );
  await createCredential(rows[0].id, PASSWORD);
  return rows[0].id;
}

describe('staff provisioning and sign-in', () => {
  before(async () => {
    await migrateTestDatabase();
    await loadFixture();
  });

  after(async () => {
    await closePool();
    // better-auth holds its own pool; close it or the runner hangs.
    await authPool.end();
  });

  test('creates the credential against the business users row', async () => {
    const userId = await provision('probe1');
    const accounts = await query<{
      provider_id: string;
      issuer: string;
      account_id: string;
      password: string;
    }>(
      `SELECT provider_id, issuer, account_id, password FROM accounts WHERE user_id = $1`,
      [userId],
    );

    assert.equal(accounts.length, 1);
    assert.equal(accounts[0].provider_id, 'credential');
    assert.equal(accounts[0].issuer, 'local:credential');
    assert.equal(accounts[0].account_id, userId);
    // NFR-06: a hash, never the password itself.
    assert.ok(!accounts[0].password.includes(PASSWORD));
    assert.ok(accounts[0].password.length > 32);
  });

  test('FR-00.6 signs in by username and opens a session', async () => {
    await provision('probe2');
    const response = await auth.api.signInUsername({
      body: { username: 'probe2', password: PASSWORD },
      asResponse: true,
    });

    assert.equal(response.status, 200);
    assert.ok(response.headers.get('set-cookie'));

    const sessions = await query<{ n: string }>(
      `SELECT count(*)::text AS n FROM sessions s
         JOIN users u ON u.id = s.user_id WHERE u.username = 'probe2'`,
    );
    assert.equal(sessions[0].n, '1');
  });

  test('refuses a wrong password', async () => {
    await provision('probe3');
    await assert.rejects(() =>
      auth.api.signInUsername({
        body: { username: 'probe3', password: 'not-the-password' },
      }),
    );
  });

  /**
   * The session must carry the business columns: every authorisation check
   * reads privilege from the user's type (BR-56) and create forms default their
   * shop from it (BR-55). If `additionalFields` were mapped wrongly these come
   * back undefined and the guards silently fail open.
   */
  test('resolves a session back to the business columns', async () => {
    await provision('probe4');
    const response = await auth.api.signInUsername({
      body: { username: 'probe4', password: PASSWORD },
      asResponse: true,
    });
    const cookie = (response.headers.get('set-cookie') ?? '').split(';')[0];

    const session = await auth.api.getSession({
      headers: new Headers({ cookie }),
    });
    const user = session?.user as unknown as Record<string, unknown>;

    assert.equal(user.username, 'probe4');
    assert.ok(user.userTypeId);
    assert.equal(user.shopId, '1');
    assert.equal(user.employeeId, 'EMP-probe4');
  });

  test('BR-56 reads privilege from the type, not from the account', async () => {
    const userId = await provision('probe5');
    const rows = await query<{ is_superuser: boolean; is_manager: boolean }>(
      `SELECT t.is_superuser, t.is_manager
         FROM users u JOIN user_types t ON t.id = u.user_type_id
        WHERE u.id = $1`,
      [userId],
    );
    assert.deepEqual(rows[0], { is_superuser: true, is_manager: true });

    // And there is no privilege column on users to contradict it.
    const columns = await query(
      `SELECT column_name FROM information_schema.columns
        WHERE table_name = 'users'
          AND column_name IN ('is_superuser','is_staff','is_manager')`,
    );
    assert.equal(columns.length, 0);
  });

  test('replaces an existing password', async () => {
    const userId = await provision('probe6');
    await replaceCredential(userId, 'a-different-password');

    await assert.rejects(() =>
      auth.api.signInUsername({
        body: { username: 'probe6', password: PASSWORD },
      }),
    );

    const response = await auth.api.signInUsername({
      body: { username: 'probe6', password: 'a-different-password' },
      asResponse: true,
    });
    assert.equal(response.status, 200);
  });

  /**
   * Regression: `internalAdapter.updatePassword` stores what it is given and
   * does not hash. Passing plaintext through it wrote the password in the clear
   * — the sign-in above would still have failed, but only after the damage was
   * on disk. Assert the stored value directly.
   */
  test('NFR-06 never stores a replaced password in the clear', async () => {
    const userId = await provision('probe7');
    await replaceCredential(userId, 'yet-another-password');

    const rows = await query<{ password: string }>(
      `SELECT password FROM accounts WHERE user_id = $1`,
      [userId],
    );
    assert.ok(!rows[0].password.includes('yet-another-password'));
    assert.ok(rows[0].password.length > 32);
  });
});
