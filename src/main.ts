import 'dotenv/config';
import { Logger, ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { toNodeHandler } from 'better-auth/node';
import express from 'express';
import helmet from 'helmet';
import { AppModule } from './app.module';
import { auth } from './config/auth';
import { DatabaseExceptionFilter } from './common/database-exception.filter';
import { isProduction, loadEnv } from './config/env';

/**
 * Note: @vercel/speed-insights is installed but not integrated here as this is
 * a backend API that doesn't serve HTML pages. Speed Insights should be
 * integrated into any frontend application that consumes this API.
 * See src/config/speed-insights.ts for configuration details.
 */

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
  app.use('/api/auth', toNodeHandler(auth));

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

// Only start a server when run directly — importing this module (as the e2e
// tests do, for `createApp`) must not bind a port.
if (require.main === module) {
  void bootstrap();
}
