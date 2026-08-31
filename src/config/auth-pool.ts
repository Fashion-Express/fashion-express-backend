import 'dotenv/config';
import { Pool } from 'pg';
import { databaseSsl, databaseUrl, loadEnv } from './env';

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
const env = loadEnv();

export const authPool = new Pool({
  connectionString: databaseUrl(env),
  // NFR-07 — the same TLS decision as the TypeORM pool. This pool carries the
  // login traffic, so it is the last one that should be reachable in clear.
  ssl: databaseSsl(env),
  max: 5,
});
