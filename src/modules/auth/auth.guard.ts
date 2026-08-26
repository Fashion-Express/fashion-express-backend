import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { type AuthUser, can } from './auth-user';
import {
  IS_PUBLIC,
  REQUIRE_MANAGER,
  REQUIRE_SUPERUSER,
  REQUIRED_PERMISSIONS,
} from './decorators';
import { SessionService } from './session.service';

/**
 * FR-00.1 and FR-00.3 — authentication and authorisation on every route.
 *
 * Registered globally, so a route is protected unless it says otherwise with
 * `@Public()`. FR-00.3 requires the checks to be enforced on the server for
 * every route, not only in the UI; hiding a menu item is presentation, this is
 * the enforcement.
 *
 * Authentication and authorisation are one guard on purpose. Splitting them
 * would mean resolving the session in one and re-reading it in the other, and
 * DB_DESIGN.MD §23.6 is explicit that the user's type should be resolved once
 * per request rather than queried by each guard.
 *
 * **What this guard does not do is row filtering.** BR-01 — a non-manager sees
 * only the sales they created — is not expressible here: a guard decides
 * whether a request may proceed, not which rows it may see. That belongs in the
 * query layer.
 */
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly sessions: SessionService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const targets = [context.getHandler(), context.getClass()];

    if (this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, targets)) {
      return true;
    }

    const request = context
      .switchToHttp()
      .getRequest<Request & { user?: AuthUser }>();

    const user = await this.sessions.resolve(request.headers);
    if (!user) {
      throw new UnauthorizedException('Sign in to continue.');
    }

    // Resolved once, then available to every controller via @CurrentUser().
    request.user = user;

    if (
      this.reflector.getAllAndOverride<boolean>(REQUIRE_SUPERUSER, targets) &&
      !user.isSuperuser
    ) {
      throw new ForbiddenException(
        'This action is restricted to administrators.',
      );
    }

    // An unrestricted type passes the manager check too — every Owner is a
    // manager (RD-14), and `can()` short-circuits the same way for permissions.
    if (
      this.reflector.getAllAndOverride<boolean>(REQUIRE_MANAGER, targets) &&
      !user.isManager &&
      !user.isSuperuser
    ) {
      throw new ForbiddenException('This action is restricted to managers.');
    }

    const required =
      this.reflector.getAllAndOverride<string[]>(
        REQUIRED_PERMISSIONS,
        targets,
      ) ?? [];

    const missing = required.filter((codename) => !can(user, codename));
    if (missing.length > 0) {
      throw new ForbiddenException(
        `You do not have permission to do this (${missing.join(', ')}).`,
      );
    }

    return true;
  }
}
