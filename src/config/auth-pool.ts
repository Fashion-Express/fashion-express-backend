import 'dotenv/config';
import { Pool } from 'pg';
import { databaseUrl, loadEnv } from './env';

/**
 * The connection pool better-auth uses.
 *
 * It lives in its own module rather than in `auth.ts` because the login-lockout
 * hooks (FR-00.9) need database access and are wired *into* the better-auth
 * config — importing the pool from `auth.ts` would be a cycle.
 *
 * This is a second pool alongside TypeORM's, which the two libraries require,
 * but it points at the same database: one schema, one set of migrations.
 */
export const authPool = new Pool({
  connectionString: databaseUrl(loadEnv()),
  max: 5,
});
