import { Injectable, Logger } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { rowsOf } from '../../common/sql';

/**
 * The permission set each user type carries (§10.3 option B).
 *
 * Cached because a guard runs on every request and the grants change perhaps a
 * handful of times in the system's life. The cache is keyed by user type, not
 * by user, so it holds four entries — and an administrator changing what a type
 * confers must change it *for everyone holding it, immediately* (BR-56), which
 * is why `invalidate()` exists and must be called by the screen that edits
 * grants.
 */
@Injectable()
export class PermissionsService {
  private readonly logger = new Logger(PermissionsService.name);
  private cache = new Map<string, ReadonlySet<string>>();

  constructor(@InjectDataSource() private readonly dataSource: DataSource) {}

  async forUserType(userTypeId: string): Promise<ReadonlySet<string>> {
    const cached = this.cache.get(userTypeId);
    if (cached) return cached;

    const rows = rowsOf<{ codename: string }>(
      await this.dataSource.query(
        `SELECT p.codename
         FROM user_type_permissions utp
         JOIN permissions p ON p.id = utp.permission_id
          WHERE utp.user_type_id = $1`,
        [userTypeId],
      ),
    );

    const set: ReadonlySet<string> = new Set(rows.map((r) => r.codename));
    this.cache.set(userTypeId, set);
    return set;
  }

  /** Call after changing what a type grants, or the change will not be seen. */
  invalidate(userTypeId?: string): void {
    if (userTypeId) {
      this.cache.delete(userTypeId);
      this.logger.log(
        `Permission cache invalidated for user type ${userTypeId}`,
      );
      return;
    }
    this.cache.clear();
    this.logger.log('Permission cache cleared');
  }

  /** The full catalogue, for the administration screen. */
  async catalogue(): Promise<
    Array<{ id: string; codename: string; label: string; module: string }>
  > {
    return rowsOf(
      await this.dataSource.query(
        `SELECT id::text, codename, label, module FROM permissions ORDER BY module, codename`,
      ),
    );
  }
}
