/**
 * FR-00.9 / FR-00.10 — login protection.
 *
 * Runs under `node --test` for the same reason the rest of the auth suite does:
 * better-auth is ESM and Jest cannot load it. See auth.test.ts.
 */
import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, test } from 'node:test';
import 'dotenv/config';
import { authPool, getAuth } from '../../src/config/auth';

/** better-auth is ESM, so the instance is built on first use. */
const authApi = async () => (await getAuth()).api;
import { createCredential } from '../../src/modules/auth/credentials';
import { checkLockout } from '../../src/modules/auth/login-attempts';
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
const IP = '203.0.113.7';

/** better-auth reads the client IP from headers; x-forwarded-for is the default. */
async function signIn(username: string, password: string, ip = IP) {
  return (await authApi()).signInUsername({
    body: { username, password },
    headers: new Headers({ 'x-forwarded-for': ip }),
    asResponse: true,
  });
}

/**
 * The status of a sign-in attempt, however it came back.
 *
 * `asResponse` turns an endpoint's *own* failure into a Response, but a `before`
 * hook that throws — which is how the lockout refuses an attempt — propagates
 * as an exception instead. Over real HTTP both end up as a status code, because
 * `toNodeHandler` catches the APIError; this helper flattens the two shapes so
 * the tests can assert on the status either way.
 */
async function statusOf(
  username: string,
  password: string,
  ip = IP,
): Promise<number> {
  try {
    return (await signIn(username, password, ip)).status;
  } catch (error) {
    const status = (error as { statusCode?: number }).statusCode;
    if (typeof status !== 'number') throw error;
    return status;
  }
}

async function attempts(username: string, ip = IP) {
  const rows = await query<{ failed_count: number; locked_until: Date | null }>(
    `SELECT failed_count, locked_until FROM login_attempts
      WHERE lower(username) = lower($1) AND ip_address = $2`,
    [username, ip],
  );
  return rows[0];
}

describe('FR-00.9 login lockout', () => {
  before(async () => {
    await migrateTestDatabase();
    await loadFixture();
    const rows = await query<{ id: string }>(
      `INSERT INTO users (username, display_username, name, email, user_type_id, status_id, shop_id)
       SELECT 'locky', 'Locky', 'Locky Test', 'locky@fashionexpress.test',
              (SELECT id FROM user_types WHERE code='owner'),
              (SELECT id FROM statuses WHERE scope='user' AND code='active'), 1
       RETURNING id`,
    );
    await createCredential(rows[0].id, PASSWORD);
  });

  beforeEach(async () => {
    await query(`DELETE FROM login_attempts`);
  });

  after(async () => {
    await closePool();
    await authPool.end();
  });

  test('counts consecutive failures', async () => {
    await signIn('locky', 'wrong');
    assert.equal((await attempts('locky')).failed_count, 1);

    await signIn('locky', 'wrong');
    assert.equal((await attempts('locky')).failed_count, 2);
  });

  test('locks on the fifth failure and refuses the sixth', async () => {
    for (let i = 0; i < 5; i++) await statusOf('locky', 'wrong');

    const row = await attempts('locky');
    assert.equal(row.failed_count, 5);
    assert.ok(row.locked_until, 'expected locked_until to be set');

    const state = await checkLockout('locky', IP);
    assert.equal(state.locked, true);

    // The sixth attempt is refused before the password is even checked — so
    // even the *correct* password does not get through.
    assert.equal(await statusOf('locky', PASSWORD), 429);
  });

  test('a retry while locked does not extend the window', async () => {
    for (let i = 0; i < 5; i++) await statusOf('locky', 'wrong');
    const first = (await attempts('locky')).locked_until!;

    await statusOf('locky', 'wrong');
    const second = (await attempts('locky')).locked_until!;

    assert.equal(new Date(first).getTime(), new Date(second).getTime());
    assert.equal((await attempts('locky')).failed_count, 5);
  });

  test('FR-00.10 a successful sign-in clears the counter', async () => {
    await signIn('locky', 'wrong');
    await signIn('locky', 'wrong');
    assert.equal((await attempts('locky')).failed_count, 2);

    const ok = await signIn('locky', PASSWORD);
    assert.equal(ok.status, 200);
    assert.equal(await attempts('locky'), undefined);
  });

  test('the lock is per username AND IP, not per username', async () => {
    for (let i = 0; i < 5; i++) await statusOf('locky', 'wrong', '203.0.113.7');
    assert.equal((await checkLockout('locky', '203.0.113.7')).locked, true);

    // A different address is unaffected, and the right password still works.
    assert.equal((await checkLockout('locky', '198.51.100.4')).locked, false);
    const response = await signIn('locky', PASSWORD, '198.51.100.4');
    assert.equal(response.status, 200);
  });

  test('capitalisation cannot side-step the counter', async () => {
    await signIn('locky', 'wrong');
    await signIn('LOCKY', 'wrong');
    await signIn('Locky', 'wrong');

    const rows = await query<{ n: string }>(
      `SELECT count(*)::text AS n FROM login_attempts`,
    );
    assert.equal(rows[0].n, '1', 'expected one shared counter row');
    assert.equal((await attempts('locky')).failed_count, 3);
  });

  test('an expired lock lifts', async () => {
    for (let i = 0; i < 5; i++) await statusOf('locky', 'wrong');
    assert.equal((await checkLockout('locky', IP)).locked, true);

    await query(
      `UPDATE login_attempts SET locked_until = now() - interval '1 minute'`,
    );

    // checkLockout clears the expired row, so the counter starts clean.
    assert.equal((await checkLockout('locky', IP)).locked, false);
    assert.equal(await attempts('locky'), undefined);

    const response = await signIn('locky', PASSWORD);
    assert.equal(response.status, 200);
  });
});
