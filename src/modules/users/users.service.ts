import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, EntityManager } from 'typeorm';
import { employeeId } from '../../common/identifiers';
import { affectedRows, firstRow, rowsOf } from '../../common/sql';
import { PAGE_SIZE, type Page, toPage } from '../../common/pagination';
import { TransactionService } from '../../common/transaction';
import { insertCredential, replaceCredential } from '../auth/credentials';
import { PermissionsService } from '../auth/permissions.service';
import type { CreateUserDto, ListUsersQuery, UpdateUserDto } from './dto';

export interface StaffRow {
  id: string;
  username: string;
  name: string;
  email: string;
  employee_id: string | null;
  phone: string;
  salary: string | null;
  join_date: string | null;
  is_active: boolean;
  status_code: string;
  status_label: string;
  user_type_id: string;
  user_type_code: string;
  user_type_label: string;
  job_position: string | null;
  department: string | null;
  shop_id: string | null;
  shop_name: string | null;
}

const SELECT_STAFF = `
  SELECT u.id::text, u.username, u.name, u.email, u.employee_id, u.phone,
         u.salary::text, u.join_date::text, u.is_active,
         s.code AS status_code, s.label AS status_label,
         u.user_type_id::text, t.code AS user_type_code, t.label AS user_type_label,
         jp.name AS job_position, d.name AS department,
         u.shop_id::text, sh.name AS shop_name
    FROM users u
    JOIN user_types t   ON t.id = u.user_type_id
    JOIN statuses   s   ON s.id = u.status_id AND s.scope = 'user'
    LEFT JOIN job_positions jp ON jp.id = u.job_position_id
    LEFT JOIN departments   d  ON d.id = u.department_id
    LEFT JOIN shops         sh ON sh.id = u.shop_id`;

@Injectable()
export class UsersService {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly transactions: TransactionService,
    private readonly permissions: PermissionsService,
  ) {}

  async list(query: ListUsersQuery): Promise<Page<StaffRow>> {
    const where: string[] = [];
    const params: unknown[] = [];

    if (query.search) {
      params.push(`%${query.search}%`);
      where.push(
        `(u.username ILIKE $${params.length} OR u.name ILIKE $${params.length}
          OR u.employee_id ILIKE $${params.length} OR u.email ILIKE $${params.length})`,
      );
    }
    if (query.statusCode) {
      params.push(query.statusCode);
      where.push(`s.code = $${params.length}`);
    }
    if (query.userTypeId) {
      params.push(query.userTypeId);
      where.push(`u.user_type_id = $${params.length}`);
    }
    if (query.shopId) {
      params.push(query.shopId);
      where.push(`u.shop_id = $${params.length}`);
    }

    const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const size = PAGE_SIZE.customers; // 10, as for every other staff-facing list
    const page = query.page && query.page > 0 ? query.page : 1;

    const counted = firstRow<{ count: string }>(
      await this.dataSource.query(
        `SELECT count(*)::text AS count
           FROM users u
           JOIN statuses s ON s.id = u.status_id AND s.scope = 'user'
           ${clause}`,
        params,
      ),
    );
    const count = counted?.count ?? '0';

    const rows = rowsOf<StaffRow>(
      await this.dataSource.query(
        `${SELECT_STAFF} ${clause} ORDER BY u.created_at DESC
           LIMIT ${size} OFFSET ${(page - 1) * size}`,
        params,
      ),
    );

    return toPage(rows, Number(count), page, size);
  }

  async findOne(id: string): Promise<StaffRow> {
    const row = firstRow<StaffRow>(
      await this.dataSource.query(`${SELECT_STAFF} WHERE u.id = $1`, [id]),
    );
    if (!row) throw new NotFoundException('No such staff account.');
    return row;
  }

  /**
   * FR-00.6 — create a staff account.
   *
   * The row and its credential are written in **one transaction**: an account
   * nobody can sign in to is not a usable half-result. `insertCredential` writes
   * through the same `EntityManager` for exactly that reason.
   *
   * FR-00.8 — the employee ID is generated here and is never accepted from the
   * caller.
   */
  async create(dto: CreateUserDto, actorId: string | null): Promise<StaffRow> {
    const id = await this.transactions.run(async (manager) => {
      const statusId = await this.resolveStatusId(
        manager,
        dto.statusCode ?? 'active',
      );

      const inserted: unknown = await manager.query(
        `INSERT INTO users (username, display_username, name, email,
                            first_name, last_name, phone, address, notes,
                            salary, join_date, employee_id,
                            user_type_id, job_position_id, department_id,
                            status_id, shop_id, created_by_id, updated_by_id)
         VALUES (lower($1), $1, $2, $3, $4, $5, $6, $7, $8,
                 $9, $10, $11, $12, $13, $14, $15, $16, $17, $17)
         RETURNING id::text`,
        [
          dto.username,
          dto.name,
          dto.email ?? '',
          dto.firstName ?? '',
          dto.lastName ?? '',
          dto.phone ?? '',
          dto.address ?? '',
          dto.notes ?? '',
          dto.salary ?? null,
          dto.joinDate ?? null,
          employeeId(),
          dto.userTypeId,
          dto.jobPositionId ?? null,
          dto.departmentId ?? null,
          statusId,
          dto.shopId ?? null,
          actorId,
        ],
      );

      const created = firstRow<{ id: string }>(inserted);
      if (!created) {
        throw new BadRequestException(
          'The staff account could not be created.',
        );
      }

      await insertCredential(manager, created.id, dto.password);
      return created.id;
    });

    return this.findOne(id);
  }

  async update(
    id: string,
    dto: UpdateUserDto,
    actorId: string | null,
  ): Promise<StaffRow> {
    const sets: string[] = [];
    const params: unknown[] = [];

    const set = (column: string, value: unknown) => {
      params.push(value);
      sets.push(`${column} = $${params.length}`);
    };

    if (dto.name !== undefined) set('name', dto.name);
    if (dto.email !== undefined) set('email', dto.email);
    if (dto.firstName !== undefined) set('first_name', dto.firstName);
    if (dto.lastName !== undefined) set('last_name', dto.lastName);
    if (dto.phone !== undefined) set('phone', dto.phone);
    if (dto.address !== undefined) set('address', dto.address);
    if (dto.notes !== undefined) set('notes', dto.notes);
    if (dto.salary !== undefined) set('salary', dto.salary);
    if (dto.joinDate !== undefined) set('join_date', dto.joinDate);
    if (dto.userTypeId !== undefined) set('user_type_id', dto.userTypeId);
    if (dto.jobPositionId !== undefined)
      set('job_position_id', dto.jobPositionId);
    if (dto.departmentId !== undefined) set('department_id', dto.departmentId);
    if (dto.shopId !== undefined) set('shop_id', dto.shopId);
    if (dto.isActive !== undefined) set('is_active', dto.isActive);

    if (dto.statusCode !== undefined) {
      set(
        'status_id',
        await this.resolveStatusId(this.dataSource.manager, dto.statusCode),
      );
    }

    // Note what cannot be set: `username`, `employee_id`, and any privilege
    // flag. The first two are immutable identifiers (FR-00.8, BR-45); the third
    // does not exist (BR-56).
    if (sets.length === 0) return this.findOne(id);

    set('updated_by_id', actorId);

    // `updated_at` is deliberately absent: the `trg_users_touch` trigger sets
    // it on every update, so setting it here too would be a second, weaker
    // source for the same fact.
    params.push(id);
    const updated: unknown = await this.dataSource.query(
      `UPDATE users SET ${sets.join(', ')}
        WHERE id = $${params.length} RETURNING id::text`,
      params,
    );
    if (affectedRows(updated) === 0) {
      throw new NotFoundException('No such staff account.');
    }

    return this.findOne(id);
  }

  async setPassword(id: string, password: string): Promise<void> {
    await this.findOne(id); // 404 rather than a silent no-op
    await replaceCredential(id, password);
  }

  /**
   * Deleting a staff account is possible but rarely right: `bill_claims.user_id`
   * is `RESTRICT` (H-12), so anyone who has ever submitted a claim cannot be
   * deleted and the database will say so. Deactivating is the supported way to
   * retire someone, and it is what preserves their history.
   */
  async remove(id: string, actingUserId: string): Promise<void> {
    if (id === actingUserId) {
      throw new BadRequestException('You cannot delete your own account.');
    }
    const deleted: unknown = await this.dataSource.query(
      `DELETE FROM users WHERE id = $1 RETURNING id`,
      [id],
    );
    if (affectedRows(deleted) === 0) {
      throw new NotFoundException('No such staff account.');
    }
  }

  /** FR-12.1 — the four types, for the create/edit form. */
  async userTypes(): Promise<
    Array<{ id: string; code: string; label: string; is_manager: boolean }>
  > {
    return rowsOf(
      await this.dataSource.query(
        `SELECT id::text, code, label, description, is_superuser, is_manager
         FROM user_types WHERE is_active ORDER BY sort_order`,
      ),
    );
  }

  /**
   * The permissions a type grants, and the full catalogue to choose from.
   * Editing grants must invalidate the cache or the change is not seen (BR-56).
   */
  async grantsFor(userTypeId: string): Promise<{
    granted: string[];
    catalogue: Array<{
      id: string;
      codename: string;
      label: string;
      module: string;
    }>;
  }> {
    const granted = await this.permissions.forUserType(userTypeId);
    return {
      granted: [...granted].sort(),
      catalogue: await this.permissions.catalogue(),
    };
  }

  private async resolveStatusId(
    manager: EntityManager,
    code: string,
  ): Promise<string> {
    const row = firstRow<{ id: string }>(
      await manager.query(
        `SELECT id::text FROM statuses WHERE scope = 'user' AND code = $1`,
        [code],
      ),
    );
    if (!row) {
      throw new BadRequestException(`Unknown staff status "${code}".`);
    }
    return row.id;
  }
}
