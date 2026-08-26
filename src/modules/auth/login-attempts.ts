import { authPool } from '../../config/auth-pool';
import { loadEnv } from '../../config/env';

/**
 * FR-00.9 / FR-00.10 — login protection.
 *
 * After **5 consecutive failed sign-in attempts for a given username + IP
 * combination**, further attempts from that combination are refused. The
 * lockout expires after **1 hour**, and a successful sign-in resets the counter.
 *
 * **Why this is not better-auth's rate limiter.** That limiter keys on IP and
 * request path, and counts *all* requests rather than failures. The requirement
 * is narrower and differently shaped: per username *and* IP, counting only
 * failures, cleared by a success. `rateLimit.customRules` cannot express any of
 * those three, so the counter is kept here and enforced by hooks around the
 * sign-in endpoint.
 *
 * The username is stored lower-cased and the unique index is on
 * `(lower(username), ip_address)`, so `Rabby` and `rabby` share one counter —
 * otherwise the lockout is side-stepped by changing capitalisation.
 */

export interface LockoutState {
  locked: boolean;
  /** When the lock lifts. Only set when `locked` is true. */
  lockedUntil?: Date;
  /** Attempts remaining before the lock engages. */
  remaining: number;
}

/**
 * Is this username/IP pair currently locked out?
 *
 * An expired lock is cleared as a side effect, so the next attempt starts from
 * a clean counter rather than inheriting the old failures — that is what
 * "the lockout expires after 1 hour" means.
 */
export async function checkLockout(
  username: string,
  ip: string,
): Promise<LockoutState> {
  const { LOGIN_MAX_ATTEMPTS } = loadEnv();

  const { rows } = await authPool.query<{
    failed_count: number;
    locked_until: Date | null;
    expired: boolean;
  }>(
    `SELECT failed_count, locked_until,
            (locked_until IS NOT NULL AND locked_until <= now()) AS expired
       FROM login_attempts
      WHERE lower(username) = lower($1) AND ip_address = $2`,
    [username, ip],
  );

  if (rows.length === 0) {
    return { locked: false, remaining: LOGIN_MAX_ATTEMPTS };
  }

  const row = rows[0];

  if (row.expired) {
    await clearAttempts(username, ip);
    return { locked: false, remaining: LOGIN_MAX_ATTEMPTS };
  }

  if (row.locked_until) {
    return {
      locked: true,
      lockedUntil: row.locked_until,
      remaining: 0,
    };
  }

  return {
    locked: false,
    remaining: Math.max(0, LOGIN_MAX_ATTEMPTS - row.failed_count),
  };
}

/**
 * Record one failed attempt, engaging the lock on the fifth.
 *
 * The upsert is a single statement so two simultaneous failed attempts cannot
 * both read `failed_count = 4` and each write `5` — the increment happens in
 * the database, not in application memory.
 */
export async function recordFailure(
  username: string,
  ip: string,
): Promise<LockoutState> {
  const { LOGIN_MAX_ATTEMPTS, LOGIN_LOCKOUT_MINUTES } = loadEnv();

  const { rows } = await authPool.query<{
    failed_count: number;
    locked_until: Date | null;
  }>(
    `INSERT INTO login_attempts (username, ip_address, failed_count, first_failed_at, last_failed_at)
          VALUES (lower($1), $2, 1, now(), now())
     ON CONFLICT (lower(username), ip_address) DO UPDATE
            SET failed_count   = login_attempts.failed_count + 1,
                last_failed_at = now(),
                locked_until   = CASE
                  WHEN login_attempts.failed_count + 1 >= $3
                  THEN now() + make_interval(mins => $4::int)
                  ELSE login_attempts.locked_until
                END
      RETURNING failed_count, locked_until`,
    [username, ip, LOGIN_MAX_ATTEMPTS, LOGIN_LOCKOUT_MINUTES],
  );

  const row = rows[0];
  return {
    locked: row.locked_until !== null,
    lockedUntil: row.locked_until ?? undefined,
    remaining: Math.max(0, LOGIN_MAX_ATTEMPTS - row.failed_count),
  };
}

/** A successful sign-in resets the counter (FR-00.10). */
export async function clearAttempts(
  username: string,
  ip: string,
): Promise<void> {
  await authPool.query(
    `DELETE FROM login_attempts WHERE lower(username) = lower($1) AND ip_address = $2`,
    [username, ip],
  );
}

/**
 * Drop lockouts that have already expired. Nothing depends on this running —
 * `checkLockout` clears them lazily — but it keeps the table from accumulating
 * rows for addresses that never come back.
 */
export async function purgeExpired(): Promise<number> {
  const result = await authPool.query(
    `DELETE FROM login_attempts WHERE locked_until IS NOT NULL AND locked_until <= now()`,
  );
  return result.rowCount ?? 0;
}
