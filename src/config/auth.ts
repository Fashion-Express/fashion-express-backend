import 'dotenv/config';
import { betterAuth } from 'better-auth';
import { username } from 'better-auth/plugins';
import { PostgresDialect } from 'kysely';
import { authPool } from './auth-pool';
import { buildLockoutHooks } from '../modules/auth/lockout-hooks';
import { isProduction, loadEnv } from './env';

/**
 * better-auth, mapped onto the business `users` table.
 *
 * DB_DESIGN.MD §3 deliberately merges the staff record and the login into one
 * row — "a staff member and a login are the same thing in this business" — and
 * every foreign key in the schema (`sales.created_by_id`, `bill_claims.user_id`,
 * `stock_histories.created_by_id`, …) points at `users.id`. Mapping better-auth
 * onto that table rather than giving it its own keeps all of them correct.
 *
 * Two consequences that differ from the document as written:
 *
 *  - **`users.password_hash` does not exist.** better-auth stores the hash in
 *    `accounts.password`, scrypt by default, which satisfies NFR-06.
 *  - **`users` carries `name`, `email_verified`, `image` and `display_username`**
 *    because better-auth's core schema and its username plugin require them.
 *    `first_name`/`last_name` stay as the business columns.
 *
 * **Every camelCase field is mapped explicitly.** The adapter config accepts a
 * `casing: 'snake'` option, but in better-auth 1.7.1 that value is declared in
 * the types and never read — it is documented as applying to table names, and
 * the Kysely adapter does not consume it at all. Relying on it produces SQL
 * referencing `accounts.userId` against a column called `user_id`. The mappings
 * below are what actually make this work; do not remove them in favour of
 * `casing`.
 */

const env = loadEnv();

export { authPool };

/** Business columns better-auth must never write. See `input: false` below. */
const businessField = (fieldName: string) =>
  ({ type: 'string', required: false, input: false, fieldName }) as const;

export const auth = betterAuth({
  database: {
    dialect: new PostgresDialect({ pool: authPool }),
    type: 'postgres',
  },

  secret: env.BETTER_AUTH_SECRET,
  baseURL: env.BETTER_AUTH_URL,
  basePath: '/api/auth',

  // NFR-09 — requests whose Origin is not on this list are rejected.
  trustedOrigins: env.TRUSTED_ORIGINS,

  // FR-00.6 — staff sign in with a username, not an email address.
  //
  // The plugin's own fields need remapping for the same reason the core ones
  // do: it declares `displayUsername` with no `fieldName`, which would target a
  // column of that literal name. `schema` is the supported override point.
  plugins: [
    username({
      schema: {
        user: { fields: { displayUsername: 'display_username' } },
      },
    }),
  ],

  emailAndPassword: {
    enabled: true,
    // Accounts are provisioned by an administrator (FR-00.6), never self-served.
    // The users module creates the row and then sets the credential through
    // better-auth, so `users.user_type_id` and `status_id` — both NOT NULL and
    // unknown to better-auth — are always populated.
    disableSignUp: true,
    minPasswordLength: 8,
  },

  user: {
    modelName: 'users',
    fields: {
      emailVerified: 'email_verified',
      createdAt: 'created_at',
      updatedAt: 'updated_at',
    },
    additionalFields: {
      // Employment and privilege columns. Every one is `input: false` so the
      // auth endpoints can never write them.
      employeeId: businessField('employee_id'),
      firstName: businessField('first_name'),
      lastName: businessField('last_name'),
      phone: businessField('phone'),
      address: businessField('address'),
      notes: businessField('notes'),
      userTypeId: businessField('user_type_id'),
      jobPositionId: businessField('job_position_id'),
      departmentId: businessField('department_id'),
      statusId: businessField('status_id'),
      statusScope: businessField('status_scope'),
      // §10.1 option B — the account's home shop defaults create forms (BR-55).
      shopId: businessField('shop_id'),
    },
  },

  session: {
    modelName: 'sessions',
    fields: {
      expiresAt: 'expires_at',
      createdAt: 'created_at',
      updatedAt: 'updated_at',
      ipAddress: 'ip_address',
      userAgent: 'user_agent',
      userId: 'user_id',
    },
  },

  account: {
    modelName: 'accounts',
    fields: {
      accountId: 'account_id',
      providerId: 'provider_id',
      userId: 'user_id',
      accessToken: 'access_token',
      refreshToken: 'refresh_token',
      idToken: 'id_token',
      accessTokenExpiresAt: 'access_token_expires_at',
      refreshTokenExpiresAt: 'refresh_token_expires_at',
      createdAt: 'created_at',
      updatedAt: 'updated_at',
    },
  },

  verification: {
    modelName: 'verifications',
    fields: {
      expiresAt: 'expires_at',
      createdAt: 'created_at',
      updatedAt: 'updated_at',
    },
  },

  // FR-00.9 / FR-00.10 — 5 failures per username+IP, cleared by a success.
  hooks: buildLockoutHooks(),

  advanced: {
    database: {
      // `users.id` is a PostgreSQL bigint identity column — the database
      // generates it, not better-auth.
      generateId: false,
    },
    // NFR-07 — secure, HTTP-only cookies in production.
    useSecureCookies: isProduction(env),
    defaultCookieAttributes: {
      httpOnly: true,
      sameSite: 'lax',
    },
  },
});

export type Auth = typeof auth;
