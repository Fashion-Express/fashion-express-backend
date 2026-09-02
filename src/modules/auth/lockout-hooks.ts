import type { BetterAuthOptions } from 'better-auth';
import {
  checkLockout,
  clearAttempts,
  type LockoutState,
  recordFailure,
} from './login-attempts';

/**
 * The two hooks that enforce FR-00.9 around better-auth's sign-in endpoints.
 *
 * `before` refuses an attempt from a locked username+IP pair before any
 * password is checked. `after` inspects what the endpoint returned and either
 * records a failure or clears the counter.
 *
 * Both are deliberately fail-open on their *own* errors: if the lockout table
 * is unreachable, sign-in still works. A brute-force protection that takes the
 * whole login system down with it when it breaks is worse than the attack.
 *
 * `better-auth/api` is loaded with `import()` for the reason set out in
 * config/auth.ts: it is ESM, this bundle is CommonJS, and `require()` of an
 * `.mjs` file is at the mercy of the host's module loader. The types below are
 * taken from the module without importing its values, so nothing here emits a
 * `require`.
 */

type AuthApi = typeof import('better-auth/api');
type APIError = InstanceType<AuthApi['APIError']>;

/** The endpoints a failed password attempt can come through. */
const SIGN_IN_PATHS = new Set(['/sign-in/username', '/sign-in/email']);

/** Read whatever identifier the endpoint was called with. */
function identifierFrom(body: unknown): string | undefined {
  if (!body || typeof body !== 'object') return undefined;
  const b = body as Record<string, unknown>;
  const value = b.username ?? b.email;
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function minutesUntil(when: Date): number {
  return Math.max(1, Math.ceil((when.getTime() - Date.now()) / 60_000));
}

/**
 * The client address, or `undefined` when there is no request to read one from.
 *
 * `auth.api.*` can be called server-side with no request and no headers — the
 * users module does exactly that when provisioning. FR-00.9 counts attempts per
 * username *and IP*, so an attempt with no address is not something the rule
 * can describe: skip it rather than inventing a placeholder that would put
 * every internal call into one shared bucket.
 */
function makeClientIp(getIP: AuthApi['getIP']) {
  return (ctx: {
    request?: Request;
    headers?: Headers;
    context: { options: Parameters<AuthApi['getIP']>[1] };
  }): string | undefined => {
    const source = ctx.request ?? ctx.headers;
    if (!source) return undefined;
    return getIP(source, ctx.context.options) ?? undefined;
  };
}

export async function buildLockoutHooks(): Promise<
  NonNullable<BetterAuthOptions['hooks']>
> {
  const { APIError, createAuthMiddleware, getIP } =
    await import('better-auth/api');
  const clientIp = makeClientIp(getIP);

  return {
    before: createAuthMiddleware(async (ctx) => {
      if (!SIGN_IN_PATHS.has(ctx.path)) return;

      const username = identifierFrom(ctx.body);
      if (!username) return;

      const ip = clientIp(ctx);
      if (!ip) return;

      let state: LockoutState;
      try {
        state = await checkLockout(username, ip);
      } catch {
        // Fail open — see the note above.
        return;
      }

      if (state.locked && state.lockedUntil) {
        throw new APIError('TOO_MANY_REQUESTS', {
          message:
            `Too many failed sign-in attempts. Try again in ` +
            `${minutesUntil(state.lockedUntil)} minute(s).`,
          code: 'ACCOUNT_TEMPORARILY_LOCKED',
        });
      }
    }),

    after: createAuthMiddleware(async (ctx) => {
      if (!SIGN_IN_PATHS.has(ctx.path)) return;

      const username = identifierFrom(ctx.body);
      if (!username) return;

      const ip = clientIp(ctx);
      if (!ip) return;

      const returned = ctx.context.returned;

      try {
        // An endpoint that failed returns (or throws) an APIError. Anything
        // else means the credentials were accepted.
        const failed =
          returned instanceof APIError ||
          (returned instanceof Error && 'status' in returned);

        if (failed) {
          // Do not count our own lockout rejection as a fresh failure, or the
          // window would extend itself every time someone retried.
          const code = (returned as APIError).body?.code;
          if (code === 'ACCOUNT_TEMPORARILY_LOCKED') return;

          await recordFailure(username, ip);
          return;
        }

        await clearAttempts(username, ip);
      } catch {
        // Fail open.
      }
    }),
  };
}
