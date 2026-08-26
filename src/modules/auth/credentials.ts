import { createLocalAccountIssuer } from 'better-auth';
import type { EntityManager } from 'typeorm';
import { auth } from '../../config/auth';

/**
 * Provisioning a staff login.
 *
 * FR-00.6 accounts are created by an administrator, never self-served, so
 * `emailAndPassword.disableSignUp` is true and better-auth's sign-up endpoint
 * is closed. That leaves a gap the library does not fill for us: something has
 * to write the credential.
 *
 * It cannot be better-auth's own sign-up path even if it were open, because
 * `users.user_type_id` and `users.status_id` are NOT NULL and better-auth knows
 * nothing about them (BR-57, BR-58). The order is therefore fixed:
 *
 *   1. the users module inserts the staff row, with its business columns;
 *   2. this helper attaches the credential to it;
 *
 * both inside one transaction, so a failure at step 2 does not leave an account
 * nobody can sign in to.
 *
 * `internalAdapter.updatePassword` is deliberately *not* used for step 2: it
 * updates an existing credential and silently does nothing when there is none.
 */

/** The provider id and synthetic issuer better-auth looks for at sign-in. */
const CREDENTIAL_PROVIDER = 'credential';

/**
 * Attach a password credential to an existing staff account.
 *
 * The hash is produced by better-auth's own hasher (scrypt by default), which
 * is what makes it verifiable at sign-in and what satisfies NFR-06.
 */
export async function createCredential(
  userId: string,
  password: string,
): Promise<void> {
  const ctx = await auth.$context;

  await ctx.internalAdapter.linkAccount({
    userId,
    providerId: CREDENTIAL_PROVIDER,
    issuer: createLocalAccountIssuer(CREDENTIAL_PROVIDER),
    // For a local credential the account id *is* the user id — that is the
    // "stable local subject" findCredentialAccount resolves against.
    accountId: userId,
    password: await ctx.password.hash(password),
  });
}

/**
 * Replace an existing password. Used by an administrator resetting an account
 * and by a staff member changing their own.
 */
export async function replaceCredential(
  userId: string,
  password: string,
): Promise<void> {
  const ctx = await auth.$context;
  const existing = await ctx.internalAdapter.findCredentialAccount(userId);

  if (!existing) {
    // No credential yet — this is a provisioning case, not a reset.
    await createCredential(userId, password);
    return;
  }

  // `updatePassword` writes the value it is given straight to
  // `accounts.password` — it does **not** hash. Passing the plaintext here
  // would store the password in the clear and then fail every subsequent
  // sign-in with "Invalid password hash". Hash first, always.
  await ctx.internalAdapter.updatePassword(
    userId,
    await ctx.password.hash(password),
  );
}

/**
 * Write the credential through the caller's transaction.
 *
 * `createCredential` above goes via better-auth's own connection pool, which is
 * a *different* connection from TypeORM's — so a failure after it would leave a
 * committed account beside a rolled-back user, or vice versa. Creating a staff
 * member is one act (FR-00.6) and must be one transaction, so the users module
 * uses this instead: better-auth still produces the hash, but the row is
 * inserted by the same `EntityManager` that inserted the user.
 */
export async function insertCredential(
  manager: EntityManager,
  userId: string,
  password: string,
): Promise<void> {
  const ctx = await auth.$context;

  // `user_id` is bigint and `account_id` is varchar, so the same value has to
  // be bound twice — reusing one placeholder for both makes PostgreSQL try to
  // deduce a single type for it and fail with 42P08.
  await manager.query(
    `INSERT INTO accounts (user_id, provider_id, issuer, account_id, password,
                           created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, now(), now())`,
    [
      userId,
      CREDENTIAL_PROVIDER,
      createLocalAccountIssuer(CREDENTIAL_PROVIDER),
      userId,
      await ctx.password.hash(password),
    ],
  );
}

/** Minimum length better-auth will accept, for surfacing in validation errors. */
export async function passwordPolicy(): Promise<{
  minLength: number;
  maxLength: number;
}> {
  const ctx = await auth.$context;
  return {
    minLength: ctx.password.config.minPasswordLength,
    maxLength: ctx.password.config.maxPasswordLength,
  };
}
