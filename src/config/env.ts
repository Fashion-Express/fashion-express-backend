import { readFileSync } from 'node:fs';
import { z } from 'zod';

/**
 * Environment validation. The application refuses to boot on a bad or missing
 * value rather than failing later at the first query — a misconfigured
 * DATABASE_URL should be a startup error, not a 500 on the first request.
 */
const envSchema = z.object({
  NODE_ENV: z
    .enum(['development', 'test', 'production'])
    .default('development'),
  PORT: z.coerce.number().int().positive().default(3000),

  DATABASE_URL: z.string().min(1),
  DATABASE_URL_TEST: z.string().min(1).optional(),

  // NFR-07 — transport security applies to the database link too. A managed
  // Postgres sits across the public internet, and node-postgres does not
  // negotiate TLS unless it is told to, so an unset value means the password
  // and every row travel in clear text. 'auto' turns TLS on for any host that
  // is not loopback; 'require' and 'disable' force the decision.
  DATABASE_SSL: z.enum(['auto', 'require', 'disable']).default('auto'),

  // The CA that signed the server certificate, as a PEM file path or the PEM
  // itself. Supabase signs its pooler certificate with a private root
  // ('Supabase Root 2021 CA') that no system trust store carries, so without
  // this the connection is encrypted but the server is unauthenticated.
  // Download it from the dashboard (Settings -> Database -> SSL configuration)
  // and point this at the file to get verification as well as encryption.
  DATABASE_SSL_CA: z.string().min(1).optional(),

  // NFR-06: the secret backing session/token signing.
  BETTER_AUTH_SECRET: z.string().min(32, {
    message: 'BETTER_AUTH_SECRET must be at least 32 characters',
  }),
  BETTER_AUTH_URL: z.string().url(),

  // NFR-09: better-auth rejects requests whose Origin is not on this list.
  TRUSTED_ORIGINS: z
    .string()
    .default('')
    .transform((v) =>
      v
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean),
    ),

  // FR-00.9 / FR-00.10
  LOGIN_MAX_ATTEMPTS: z.coerce.number().int().positive().default(5),
  LOGIN_LOCKOUT_MINUTES: z.coerce.number().int().positive().default(60),
});

export type Env = z.infer<typeof envSchema>;

let cached: Env | undefined;

export function loadEnv(): Env {
  if (cached) return cached;

  const parsed = envSchema.safeParse(process.env);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  ${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('\n');
    throw new Error(`Invalid environment configuration:\n${issues}`);
  }

  cached = parsed.data;
  return cached;
}

/**
 * The connection string for the current NODE_ENV. Tests run against a separate
 * database because the constraint suite (DB_DESIGN.MD §20) resets it per run.
 */
export function databaseUrl(env: Env = loadEnv()): string {
  if (env.NODE_ENV === 'test') {
    if (!env.DATABASE_URL_TEST) {
      throw new Error('DATABASE_URL_TEST must be set when NODE_ENV=test');
    }
    return env.DATABASE_URL_TEST;
  }
  return env.DATABASE_URL;
}

/** What `pg` accepts for its `ssl` field, narrowed to what we ever produce. */
export type DatabaseSsl = false | { rejectUnauthorized: boolean; ca?: string };

/** Hosts reached over the loopback interface, where TLS buys nothing. */
const LOOPBACK = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

/**
 * Whether a connection string stays on this machine. An empty hostname is a
 * Unix-socket connection, which is also local. A string this cannot parse is
 * treated as remote: the safe direction to fail in is "encrypt anyway".
 */
function isLoopback(url: string): boolean {
  try {
    const host = new URL(url).hostname;
    return host === '' || LOOPBACK.has(host);
  } catch {
    return false;
  }
}

/**
 * The TLS settings for the current connection string (NFR-07).
 *
 * `DATABASE_SSL_CA` decides how strong the guarantee is. With it, the server
 * certificate is verified against that root — encryption *and* proof of who
 * answered. Without it, `rejectUnauthorized` has to be false, because the
 * managed providers sign with private roots the system store does not know;
 * the traffic is still encrypted, but a machine-in-the-middle is not ruled out.
 */
export function databaseSsl(
  env: Env = loadEnv(),
  url: string = databaseUrl(env),
): DatabaseSsl {
  if (env.DATABASE_SSL === 'disable') return false;
  if (env.DATABASE_SSL === 'auto' && isLoopback(url)) return false;

  const source = env.DATABASE_SSL_CA;
  if (!source) return { rejectUnauthorized: false };

  // Accept the certificate inline as well as by path — a container secret is
  // usually mounted as an environment variable, not a file.
  const ca = source.startsWith('-----BEGIN')
    ? source
    : readFileSync(source, 'utf8');

  return { ca, rejectUnauthorized: true };
}

export const isProduction = (env: Env = loadEnv()) =>
  env.NODE_ENV === 'production';
