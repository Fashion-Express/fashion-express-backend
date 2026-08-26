import {
  createParamDecorator,
  ExecutionContext,
  SetMetadata,
} from '@nestjs/common';
import type { Request } from 'express';
import type { AuthUser } from './auth-user';

/**
 * FR-00.1 — every route requires authentication; there is no anonymous access.
 * `AuthGuard` is registered globally, so this decorator is the *only* way a
 * route becomes public, and each use should be obvious on inspection.
 */
export const IS_PUBLIC = 'fe:isPublic';
export const Public = () => SetMetadata(IS_PUBLIC, true);

/**
 * FR-00.2 mechanism 1 and 2 — a named capability, whether it gates a record
 * operation (`add_sale`) or an action with no record of its own
 * (`finalize_sale`, `review_bills`, `view_reports_menu`).
 *
 * Listing several requires *all* of them.
 */
export const REQUIRED_PERMISSIONS = 'fe:permissions';
export const RequirePermission = (...codenames: string[]) =>
  SetMetadata(REQUIRED_PERMISSIONS, codenames);

/**
 * BR-33, FR-09.5 — "manager-only". Read from the user's type (BR-56), not from
 * a permission, because it is a privilege *level* rather than a capability.
 */
export const REQUIRE_MANAGER = 'fe:requireManager';
export const RequireManager = () => SetMetadata(REQUIRE_MANAGER, true);

/**
 * BR-41 — restricted to unrestricted accounts. Used by the data-cleanup tool
 * and anything else genuinely destructive.
 */
export const REQUIRE_SUPERUSER = 'fe:requireSuperuser';
export const RequireSuperuser = () => SetMetadata(REQUIRE_SUPERUSER, true);

/** The signed-in staff member, resolved once per request by `AuthGuard`. */
export const CurrentUser = createParamDecorator(
  (field: keyof AuthUser | undefined, ctx: ExecutionContext) => {
    const request = ctx
      .switchToHttp()
      .getRequest<Request & { user?: AuthUser }>();
    const user = request.user;
    return field && user ? user[field] : user;
  },
);
