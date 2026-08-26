import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { fromNodeHeaders } from 'better-auth/node';
import type { IncomingHttpHeaders } from 'node:http';
import { DataSource } from 'typeorm';
import { rowsOf } from '../../common/sql';
import { auth } from '../../config/auth';
import type { AuthUser } from './auth-user';
import { PermissionsService } from './permissions.service';

/**
 * Turns an incoming request's cookies into an {@link AuthUser}.
 *
 * better-auth validates the session and gives back its own user record; this
 * service then resolves the two things the requirements care about which
 * better-auth knows nothing of — the privilege the user's *type* confers
 * (BR-56) and the permission set that type grants (§10.3).
 *
 * DB_DESIGN.MD §23.6 asks for this to happen **once** per request, with the
 * result attached to the request context, so that guards do not each issue a
 * query. `AuthGuard` does exactly that.
 */
@Injectable()
export class SessionService {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly permissions: PermissionsService,
  ) {}

  async resolve(headers: IncomingHttpHeaders): Promise<AuthUser | null> {
    const session = await auth.api.getSession({
      headers: fromNodeHeaders(headers),
    });
    if (!session?.user?.id) return null;

    return this.load(String(session.user.id));
  }

  /**
   * Load a user and their privilege in one query.
   *
   * The join to `user_types` is the whole of BR-56: privilege is read from the
   * type every time, so changing what a type confers changes it for everyone
   * holding it immediately, with no copy on the account to go stale.
   */
  async load(userId: string): Promise<AuthUser | null> {
    const rows = rowsOf<{
      id: string;
      username: string;
      name: string;
      display_username: string | null;
      is_active: boolean;
      user_type_id: string;
      user_type_code: string;
      is_superuser: boolean;
      is_manager: boolean;
      shop_id: string | null;
      status_code: string;
    }>(
      await this.dataSource.query(
        `SELECT u.id::text,
              u.username,
              u.name,
              u.display_username,
              u.is_active,
              u.user_type_id::text,
              t.code       AS user_type_code,
              t.is_superuser,
              t.is_manager,
              u.shop_id::text,
              s.code       AS status_code
         FROM users u
         JOIN user_types t ON t.id = u.user_type_id
         JOIN statuses   s ON s.id = u.status_id AND s.scope = 'user'
          WHERE u.id = $1`,
        [userId],
      ),
    );

    const row = rows[0];
    if (!row) return null;

    /**
     * `is_active` and the staff status answer different questions and both must
     * hold. FR-00.7 gives an account Active / Inactive / On Leave; `is_active`
     * says whether it may authenticate at all. Someone on leave should not be
     * signing in, so both gate access here — but neither is folded into the
     * other, because suspending a person must not lose their real
     * classification (DB_DESIGN.MD §3).
     */
    if (!row.is_active || row.status_code !== 'active') return null;

    return {
      id: row.id,
      username: row.username,
      displayName: row.name || row.display_username || row.username,
      isActive: row.is_active,
      userTypeId: row.user_type_id,
      userTypeCode: row.user_type_code,
      isSuperuser: row.is_superuser,
      isManager: row.is_manager,
      shopId: row.shop_id,
      permissions: await this.permissions.forUserType(row.user_type_id),
    };
  }
}
