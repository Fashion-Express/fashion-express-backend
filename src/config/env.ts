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

export const isProduction = (env: Env = loadEnv()) =>
  env.NODE_ENV === 'production';
