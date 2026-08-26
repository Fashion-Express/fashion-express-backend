import { Controller, Get } from '@nestjs/common';
import type { AuthUser } from './auth-user';
import { CurrentUser } from './decorators';

/**
 * Sign-in, sign-out and session refresh are served by better-auth's own handler
 * mounted at `/api/auth/*` (see main.ts) — Nest does not route them.
 *
 * What Nest adds is this: the shape the *application* needs, which better-auth's
 * `/get-session` cannot give because it knows nothing about user types or
 * permissions.
 */
@Controller('me')
export class AuthController {
  /**
   * Everything the client needs to render the shell.
   *
   * FR-00.3 — the navigation sidebar hides any module the user cannot open and
   * action buttons are absent when the permission is missing. The client cannot
   * decide that on its own, so the permission set is returned here. This is
   * presentation data; the enforcement is `AuthGuard` on every route.
   */
  @Get()
  me(@CurrentUser() user: AuthUser): {
    id: string;
    username: string;
    displayName: string;
    userType: {
      id: string;
      code: string;
      isSuperuser: boolean;
      isManager: boolean;
    };
    shopId: string | null;
    permissions: string[];
  } {
    return {
      id: user.id,
      username: user.username,
      displayName: user.displayName,
      userType: {
        id: user.userTypeId,
        code: user.userTypeCode,
        isSuperuser: user.isSuperuser,
        isManager: user.isManager,
      },
      shopId: user.shopId,
      // Sorted so the payload is stable and diffable in the browser.
      permissions: [...user.permissions].sort(),
    };
  }
}
