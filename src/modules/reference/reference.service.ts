import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { PAGE_SIZE, type Page, toPage } from '../../common/pagination';
import { affectedRows, firstRow, rowsOf } from '../../common/sql';
import type { AuthUser } from '../auth/auth-user';
import { PermissionsService } from '../auth/permissions.service';
import type {
  CreateReferenceDto,
  ListReferenceQuery,
  UpdateReferenceDto,
} from './dto';
import {
  capabilitiesOf,
  findList,
  REFERENCE_LISTS,
  type ReferenceList,
} from './registry';

export interface ReferenceRow {
  id: string;
  code?: string;
  label?: string;
  name?: string;
  description?: string;
  scope?: string;
  sort_order?: number;
  is_active: boolean;
}

@Injectable()
export class ReferenceService {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly permissions: PermissionsService,
  ) {}

  /** Resolve a URL segment to a list, or 404. This is also the SQL whitelist. */
  resolve(slug: string): ReferenceList {
    const list = findList(slug);
    if (!list) {
      throw new NotFoundException(
        `No such reference list "${slug}". See GET /api/reference for the catalogue.`,
      );
    }
    return list;
  }

  /** The catalogue, so a client knows which screens to draw (FR-12.5.2). */
  catalogue(): Array<Record<string, unknown>> {
    return REFERENCE_LISTS.map((list) => ({
      slug: list.slug,
      label: list.label,
      kind: list.kind,
      scopes: list.scopes ?? null,
      note: list.note ?? null,
      ...capabilitiesOf(list),
    }));
  }

  async list(
    slug: string,
    query: ListReferenceQuery,
  ): Promise<Page<ReferenceRow>> {
    const list = this.resolve(slug);
    const where: string[] = [];
    const params: unknown[] = [];

    if (query.search) {
      params.push(`%${query.search}%`);
      const columns = list.kind === 'named' ? ['name'] : ['code', 'label'];
      where.push(
        `(${columns.map((c) => `${c} ILIKE $${params.length}`).join(' OR ')})`,
      );
    }
    if (query.scope !== undefined) {
      this.assertScope(list, query.scope);
      params.push(query.scope);
      where.push(`scope = $${params.length}`);
    }
    if (query.isActive !== undefined) {
      params.push(query.isActive);
      where.push(`is_active = $${params.length}`);
    }

    const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const size = PAGE_SIZE.reference; // 25 (RD-12)
    const page = query.page && query.page > 0 ? query.page : 1;

    const counted = firstRow<{ count: string }>(
      await this.dataSource.query(
        `SELECT count(*)::text AS count FROM ${list.table} ${clause}`,
        params,
      ),
    );

    const rows = rowsOf<ReferenceRow>(
      await this.dataSource.query(
        `SELECT ${this.selectColumns(list)} FROM ${list.table} ${clause}
          ORDER BY ${this.orderBy(list)}
          LIMIT ${size} OFFSET ${(page - 1) * size}`,
        params,
      ),
    );

    return toPage(rows, Number(counted?.count ?? '0'), page, size);
  }

  /**
   * The picker feed: active entries only, unpaginated.
   *
   * §23.6 — inactive entries are filtered out of dropdowns but *not* out of
   * reads. An item whose category was deactivated still has to display that
   * category; only the picker hides it. Filtering `is_active` in the wrong
   * place makes existing records look broken.
   */
  async options(slug: string, scope?: string): Promise<ReferenceRow[]> {
    const list = this.resolve(slug);
    const params: unknown[] = [];
    let clause = 'WHERE is_active';

    if (scope !== undefined) {
      this.assertScope(list, scope);
      params.push(scope);
      clause += ` AND scope = $${params.length}`;
    } else if (list.scopes) {
      // Unscoped picker on a scoped list would offer LC on a customer receipt,
      // which the database then refuses (BR-62) — a confusing error for
      // something the UI should never have shown.
      throw new BadRequestException(
        `"${list.slug}" is scoped. Pass ?scope= one of: ${list.scopes.join(', ')}.`,
      );
    }

    return rowsOf<ReferenceRow>(
      await this.dataSource.query(
        `SELECT ${this.selectColumns(list)} FROM ${list.table} ${clause}
          ORDER BY ${this.orderBy(list)}`,
        params,
      ),
    );
  }

  async findOne(slug: string, id: string): Promise<ReferenceRow> {
    const list = this.resolve(slug);
    const row = firstRow<ReferenceRow>(
      await this.dataSource.query(
        `SELECT ${this.selectColumns(list)} FROM ${list.table} WHERE id = $1`,
        [id],
      ),
    );
    if (!row) throw new NotFoundException('No such entry.');
    return row;
  }

  async create(
    slug: string,
    dto: CreateReferenceDto,
    actor: AuthUser,
  ): Promise<ReferenceRow> {
    const list = this.resolve(slug);

    if (list.kind === 'structural') {
      throw new BadRequestException(
        `"${list.label}" is a structural list: entries cannot be added. ` +
          `The system is the only writer of the records that use it, so a new ` +
          `entry could never appear on one.`,
      );
    }

    const columns: string[] = [];
    const values: unknown[] = [];
    const add = (column: string, value: unknown) => {
      columns.push(column);
      values.push(value);
    };

    if (list.kind === 'named') {
      if (!dto.name) throw new BadRequestException('name is required.');
      if (dto.code) {
        throw new BadRequestException(
          `"${list.label}" entries have a name only — there is no code to key on.`,
        );
      }
      add('name', dto.name);
    } else {
      if (!dto.code) throw new BadRequestException('code is required.');
      if (!dto.label) throw new BadRequestException('label is required.');
      add('code', dto.code);
      add('label', dto.label);
    }

    if (list.scopes) {
      if (!dto.scope) {
        throw new BadRequestException(
          `scope is required for "${list.slug}": one of ${list.scopes.join(', ')}.`,
        );
      }
      this.assertScope(list, dto.scope);
      add('scope', dto.scope);
    } else if (dto.scope) {
      throw new BadRequestException(`"${list.slug}" is not scoped.`);
    }

    if (dto.description !== undefined) {
      if (!list.hasDescription) {
        throw new BadRequestException(`"${list.slug}" has no description.`);
      }
      add('description', dto.description);
    }
    if (dto.sortOrder !== undefined && list.hasSortOrder) {
      add('sort_order', dto.sortOrder);
    }
    if (dto.isActive !== undefined) add('is_active', dto.isActive);

    this.applyPrivilegeFlags(list, dto, actor, add);

    add('created_by_id', actor.id);
    add('updated_by_id', actor.id);

    const inserted: unknown = await this.dataSource.query(
      `INSERT INTO ${list.table} (${columns.join(', ')})
       VALUES (${columns.map((_, i) => `$${i + 1}`).join(', ')})
       RETURNING ${this.selectColumns(list)}`,
      values,
    );

    const row = firstRow<ReferenceRow>(inserted);
    if (!row) throw new BadRequestException('The entry could not be created.');
    this.invalidateIfUserTypes(list, row.id);
    return row;
  }

  async update(
    slug: string,
    id: string,
    dto: UpdateReferenceDto,
    actor: AuthUser,
  ): Promise<ReferenceRow> {
    const list = this.resolve(slug);
    const sets: string[] = [];
    const params: unknown[] = [];
    const set = (column: string, value: unknown) => {
      params.push(value);
      sets.push(`${column} = $${params.length}`);
    };

    /**
     * FR-12.5.2 — a structural list offers editing of the label and nothing
     * else. Not the sort order, and not `is_active`: retiring `debit` is not
     * something the business can sensibly do, because every ledger writer
     * targets one of these entries (§23.1).
     */
    if (list.kind === 'structural') {
      const offered = Object.keys(dto).filter(
        (k) => dto[k as keyof UpdateReferenceDto] !== undefined,
      );
      const disallowed = offered.filter((k) => k !== 'label');
      if (disallowed.length > 0) {
        throw new BadRequestException(
          `"${list.label}" is a structural list: only the label may be edited. ` +
            `Refused: ${disallowed.join(', ')}.`,
        );
      }
      if (dto.label === undefined) return this.findOne(slug, id);
      set('label', dto.label);
    } else {
      if (dto.name !== undefined) {
        if (list.kind !== 'named') {
          throw new BadRequestException(
            `"${list.slug}" entries carry a label, not a name.`,
          );
        }
        set('name', dto.name);
      }
      if (dto.label !== undefined) {
        if (list.kind === 'named') {
          throw new BadRequestException(
            `"${list.slug}" entries carry a name, not a label.`,
          );
        }
        set('label', dto.label);
      }
      if (dto.description !== undefined) {
        if (!list.hasDescription) {
          throw new BadRequestException(`"${list.slug}" has no description.`);
        }
        set('description', dto.description);
      }
      if (dto.sortOrder !== undefined) {
        if (!list.hasSortOrder) {
          throw new BadRequestException(`"${list.slug}" has no sort order.`);
        }
        set('sort_order', dto.sortOrder);
      }
      if (dto.isActive !== undefined) set('is_active', dto.isActive);
      this.applyPrivilegeFlags(list, dto, actor, (column, value) =>
        set(column, value),
      );
    }

    if (sets.length === 0) return this.findOne(slug, id);

    set('updated_by_id', actor.id);

    // `updated_at` is left to the trg_*_touch trigger (migration 016).
    params.push(id);
    const updated: unknown = await this.dataSource.query(
      `UPDATE ${list.table} SET ${sets.join(', ')}
        WHERE id = $${params.length}
        RETURNING ${this.selectColumns(list)}`,
      params,
    );

    if (affectedRows(updated) === 0)
      throw new NotFoundException('No such entry.');
    this.invalidateIfUserTypes(list, id);
    return firstRow<ReferenceRow>(updated)!;
  }

  /**
   * BR-60 — an entry referenced by any record cannot be deleted.
   *
   * The database enforces this with `ON DELETE RESTRICT` on every reference, so
   * this method does not need to check first; the constraint produces a 409
   * through the exception filter. What it does do is refuse *before* trying on
   * a structural list, where deletion is not a thing at all (BR-61, BR-66).
   */
  async remove(slug: string, id: string): Promise<void> {
    const list = this.resolve(slug);

    if (list.kind === 'structural') {
      throw new BadRequestException(
        `"${list.label}" is a structural list: entries cannot be deleted.`,
      );
    }

    const usage = await this.usage(slug, id);
    if (usage.total > 0) {
      throw new ConflictException(
        `That entry is used by ${usage.total} record(s) and cannot be deleted. ` +
          `Deactivate it instead — it will disappear from selection lists while ` +
          `every existing record keeps its meaning.`,
      );
    }

    const deleted: unknown = await this.dataSource.query(
      `DELETE FROM ${list.table} WHERE id = $1 RETURNING id`,
      [id],
    );
    if (affectedRows(deleted) === 0)
      throw new NotFoundException('No such entry.');
    this.invalidateIfUserTypes(list, id);
  }

  /**
   * How many records use this entry, and where.
   *
   * Answers "what breaks if I retire this?" before the user finds out from a
   * constraint violation — the same courtesy FR-11.2.2 asks for on shops. The
   * referencing tables are discovered from the catalogue rather than listed,
   * so a new foreign key is counted without anyone remembering to add it here.
   */
  async usage(
    slug: string,
    id: string,
  ): Promise<{ total: number; byTable: Record<string, number> }> {
    const list = this.resolve(slug);

    const references = rowsOf<{ table_name: string; column_name: string }>(
      await this.dataSource.query(
        `SELECT src.relname AS table_name, att.attname AS column_name
           FROM pg_constraint c
           JOIN pg_class src ON src.oid = c.conrelid
           JOIN pg_attribute att
             ON att.attrelid = c.conrelid AND att.attnum = c.conkey[1]
          WHERE c.contype = 'f'
            AND c.confrelid = $1::regclass
            AND src.relname <> $2`,
        [list.table, list.table],
      ),
    );

    const byTable: Record<string, number> = {};
    let total = 0;

    const excluded = new Set(list.usageExcludes ?? []);

    for (const ref of references) {
      // An entry's own rows are not a reason it cannot be deleted (BR-60).
      if (excluded.has(ref.table_name)) continue;
      // Both identifiers come from the catalogue, never from the request.
      const counted = firstRow<{ n: string }>(
        await this.dataSource.query(
          `SELECT count(*)::text AS n FROM ${ref.table_name} WHERE ${ref.column_name} = $1`,
          [id],
        ),
      );
      const n = Number(counted?.n ?? '0');
      if (n > 0) {
        byTable[`${ref.table_name}.${ref.column_name}`] = n;
        total += n;
      }
    }

    return { total, byTable };
  }

  // ---- helpers -------------------------------------------------------

  private selectColumns(list: ReferenceList): string {
    const columns = ['id::text'];
    if (list.kind === 'named') columns.push('name');
    else columns.push('code', 'label');
    if (list.scopes) columns.push('scope');
    if (list.hasDescription) columns.push('description');
    if (list.hasSortOrder) columns.push('sort_order');
    columns.push(...(list.extraColumns ?? []));
    columns.push('is_active');
    return columns.join(', ');
  }

  private orderBy(list: ReferenceList): string {
    const parts = list.scopes ? ['scope'] : [];
    if (list.hasSortOrder) parts.push('sort_order');
    parts.push(list.kind === 'named' ? 'name' : 'label');
    return parts.join(', ');
  }

  private assertScope(list: ReferenceList, scope: string): void {
    if (!list.scopes) {
      throw new BadRequestException(`"${list.slug}" is not scoped.`);
    }
    if (!list.scopes.includes(scope)) {
      throw new BadRequestException(
        `Unknown scope "${scope}" for ${list.slug}. Valid: ${list.scopes.join(', ')}.`,
      );
    }
  }

  /**
   * FR-12.1.2 — the privilege a user type confers.
   *
   * **Restricted to administrators, unlike the rest of this module.** Writing
   * these two columns is not editing reference data, it is handing out
   * privilege: `manage_referencedata` alone used to be enough to create a type
   * with `is_superuser`, and `change_user` is enough to point an account at a
   * type — so a manager, who holds both, could mint an unrestricted role and
   * move themselves into it in two requests. Both directions are guarded, not
   * just the grant: clearing `is_manager` on the Manager type would demote
   * every manager at once (BR-56), which is the same authority in reverse.
   */
  private applyPrivilegeFlags(
    list: ReferenceList,
    dto: { isSuperuser?: boolean; isManager?: boolean },
    actor: AuthUser,
    add: (column: string, value: unknown) => void,
  ): void {
    const supported = (list.extraColumns ?? []).includes('is_superuser');
    for (const [key, column] of [
      ['isSuperuser', 'is_superuser'],
      ['isManager', 'is_manager'],
    ] as const) {
      const value = dto[key];
      if (value === undefined) continue;
      if (!supported) {
        throw new BadRequestException(`"${list.slug}" has no ${key}.`);
      }
      if (!actor.isSuperuser) {
        throw new ForbiddenException(
          `Setting ${key} decides what every holder of a type may do, so it ` +
            'is restricted to administrators.',
        );
      }
      add(column, value);
    }
  }

  /**
   * BR-56 — changing what a *type* confers changes it for everyone holding it,
   * immediately. The permission set is cached per type, so an edit that did not
   * clear the cache would take effect only after a restart.
   */
  private invalidateIfUserTypes(list: ReferenceList, id: string): void {
    if (list.table === 'user_types') this.permissions.invalidate(id);
  }
}
