import 'dotenv/config';
import { Logger, ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import express from 'express';
import helmet from 'helmet';
import { AppModule } from './app.module';
import { getAuth } from './config/auth';
import { DatabaseExceptionFilter } from './common/database-exception.filter';
import { isProduction, loadEnv } from './config/env';

/**
 * Build the application with every piece of middleware in place.
 *
 * Extracted from `bootstrap` so the end-to-end tests exercise *this* wiring
 * rather than a reimplementation of it — the ordering below (auth handler
 * before the body parsers) is load-bearing, and a test that set it up
 * separately could pass while production was broken.
 */
export async function createApp(): Promise<NestExpressApplication> {
  const env = loadEnv();

  /**
   * `bodyParser: false` is required, not stylistic.
   *
   * better-auth's handler reads the raw request body itself. Nest's parser, if
   * left on, is installed during `create()` — before any `app.use()` we could
   * add — and would consume the stream first, so every sign-in would arrive
   * with an empty body. The parsers are therefore added by hand below, *after*
   * the auth handler is mounted.
   */
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    bodyParser: false,
  });

  // NFR-07 / NFR-08 — HSTS, clickjacking protection and a content security
  // policy; the permissions policy blocks camera, microphone, location and
  // payment APIs outright.
  app.use(
    helmet({
      hsts: isProduction(env)
        ? { maxAge: 31_536_000, includeSubDomains: true, preload: true }
        : false,
      contentSecurityPolicy: {
        directives: {
          defaultSrc: ["'self'"],
          frameAncestors: ["'none'"],
          objectSrc: ["'none'"],
        },
      },
    }),
  );
  app.use(
    (
      _req: express.Request,
      res: express.Response,
      next: express.NextFunction,
    ) => {
      res.setHeader(
        'Permissions-Policy',
        'camera=(), microphone=(), geolocation=(), payment=()',
      );
      next();
    },
  );

  /**
   * NFR-09 — cross-site request forgery.
   *
   * Three mechanisms, and it is worth knowing which covers what, because they
   * do not cover the same routes:
   *
   *  - **`SameSite=Lax` on the session cookie** (config/auth.ts). The browser
   *    will not attach it to a cross-site POST, so a form on another origin
   *    cannot act as the signed-in user. This is what protects the Nest routes.
   *  - **CORS**, below, withholds `Access-Control-Allow-Origin` from any origin
   *    not on the list, so script elsewhere cannot *read* a response.
   *  - **better-auth's own origin check**, on its routes only. It applies when
   *    the request carries a session cookie: a missing `Origin` is refused with
   *    `MISSING_OR_NULL_ORIGIN` and an untrusted one with `INVALID_ORIGIN`,
   *    both 403. An anonymous sign-in carries no cookie and so is not checked —
   *    which is why signing in from curl works without an `Origin` header, but
   *    every later `/api/auth/*` call from the same client needs one.
   *
   * None of this constrains a non-browser client such as Postman beyond that
   * header, and it is not meant to: CSRF is a browser attack, and a direct
   * client presenting valid credentials is simply a client.
   *
   * `credentials: true` is what lets a browser send the cookie at all, so the
   * origin list must stay tight.
   */
  app.enableCors({
    origin: env.TRUSTED_ORIGINS.length > 0 ? env.TRUSTED_ORIGINS : false,
    credentials: true,
  });

  // Mounted before the body parsers, and outside Nest's router — better-auth
  // owns every route under this prefix (sign-in, sign-out, session refresh).
  //
  // `better-auth/node` is ESM and this file compiles to CommonJS, so it is
  // loaded with `import()`. config/auth.ts explains why that is not optional:
  // a `require()` of the `.mjs` build is refused outright by Vercel's function
  // loader, which is what took the first deployment down before it served a
  // request.
  const { toNodeHandler } = await import('better-auth/node');
  app.use('/api/auth', toNodeHandler(await getAuth()));

  app.use(express.json({ limit: '1mb' }));
  app.use(express.urlencoded({ extended: true, limit: '1mb' }));

  app.setGlobalPrefix('api');

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );

  app.useGlobalFilters(new DatabaseExceptionFilter());

  return app;
}

async function bootstrap(): Promise<void> {
  const env = loadEnv();
  const app = await createApp();

  await app.listen(env.PORT);
  new Logger('Bootstrap').log(
    `Fashion Express API listening on :${env.PORT} (${env.NODE_ENV})`,
  );
}

/**
 * Start a server only when this file is *run*, not when it is imported.
 *
 * The e2e suites import it for `createApp`, and a serverless host imports it
 * for the default export below; neither wants a listening socket.
 */
if (require.main === module) {
  void bootstrap();
}

/**
 * The serverless entry point.
 *
 * Vercel loads `src/main.js` through its own module loader and requires a
 * default export that is "a function or server" — it does not run the file as
 * a program and then wait for it to listen, which is what an earlier version of
 * this file assumed. Without this export the process exits 1 with `Invalid
 * export found in module` and every request is a 500 that the build log gives
 * no hint of.
 *
 * So: no `listen()`. `app.init()` wires the same application the local server
 * runs — every pipe, filter and the hand-mounted better-auth handler, because
 * all of that lives in `createApp()` — and the Express instance underneath it
 * is itself a `(req, res)` function, which is exactly what the host wants to
 * call.
 *
 * The promise is memoised at module scope so a warm instance pays the Nest
 * bootstrap once rather than per request, and cleared on failure so a cold
 * start that loses the database does not leave every later request holding a
 * rejected promise it can never recover from.
 */
let started: Promise<NestExpressApplication> | undefined;

function serverlessApp(): Promise<NestExpressApplication> {
  started ??= (async () => {
    const app = await createApp();
    await app.init();
    return app;
  })().catch((error: unknown) => {
    started = undefined;
    throw error;
  });

  return started;
}

export default async function handler(
  req: express.Request,
  res: express.Response,
): Promise<void> {
  const app = await serverlessApp();
  app.getHttpAdapter().getInstance()(req, res);
}
