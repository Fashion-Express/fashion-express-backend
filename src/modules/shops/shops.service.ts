import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { PAGE_SIZE, type Page, toPage } from '../../common/pagination';
import { affectedRows, firstRow, rowsOf } from '../../common/sql';
import type { CreateShopDto, ListShopsQuery, UpdateShopDto } from './dto';

export interface ShopRow {
  id: string;
  name: string;
  description: string;
  is_active: boolean;
  customer_count: string;
  inventory_count: string;
  sale_count: string;
  staff_count: string;
}

/**
 * FR-11.2.2 — the list shows what each shop holds, "so the consequences of
 * deactivating one are visible before acting". The counts are computed as
 * correlated subqueries rather than joins so a shop with nothing still appears.
 */
const SELECT_SHOP = `
  SELECT s.id::text, s.name, s.description, s.is_active,
         (SELECT count(*)::text FROM customers       c WHERE c.shop_id = s.id) AS customer_count,
         (SELECT count(*)::text FROM inventory_items i WHERE i.shop_id = s.id) AS inventory_count,
         (SELECT count(*)::text FROM sales           x WHERE x.shop_id = s.id) AS sale_count,
         (SELECT count(*)::text FROM users           u WHERE u.shop_id = s.id) AS staff_count
    FROM shops s`;

@Injectable()
export class ShopsService {
  constructor(@InjectDataSource() private readonly dataSource: DataSource) {}

  async list(query: ListShopsQuery): Promise<Page<ShopRow>> {
    const where: string[] = [];
    const params: unknown[] = [];

    if (query.search) {
      params.push(`%${query.search}%`);
      where.push(`s.name ILIKE $${params.length}`);
    }
    if (query.isActive !== undefined) {
      params.push(query.isActive);
      where.push(`s.is_active = $${params.length}`);
    }

    const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const size = PAGE_SIZE.shops;
    const page = query.page && query.page > 0 ? query.page : 1;

    const counted = firstRow<{ count: string }>(
      await this.dataSource.query(
        `SELECT count(*)::text AS count FROM shops s ${clause}`,
        params,
      ),
    );

    const rows = rowsOf<ShopRow>(
      await this.dataSource.query(
        `${SELECT_SHOP} ${clause} ORDER BY s.name
          LIMIT ${size} OFFSET ${(page - 1) * size}`,
        params,
      ),
    );

    return toPage(rows, Number(counted?.count ?? '0'), page, size);
  }

  /** Active shops only, for the shop pickers on every create form. */
  async options(): Promise<Array<{ id: string; name: string }>> {
    return rowsOf(
      await this.dataSource.query(
        `SELECT id::text, name FROM shops WHERE is_active ORDER BY name`,
      ),
    );
  }

  async findOne(id: string): Promise<ShopRow> {
    const row = firstRow<ShopRow>(
      await this.dataSource.query(`${SELECT_SHOP} WHERE s.id = $1`, [id]),
    );
    if (!row) throw new NotFoundException('No such shop.');
    return row;
  }

  async create(dto: CreateShopDto, actorId: string | null): Promise<ShopRow> {
    const inserted: unknown = await this.dataSource.query(
      `INSERT INTO shops (name, description, is_active, created_by_id, updated_by_id)
       VALUES ($1, $2, $3, $4, $4) RETURNING id::text`,
      [dto.name, dto.description ?? '', dto.isActive ?? true, actorId],
    );
    return this.findOne(firstRow<{ id: string }>(inserted)!.id);
  }

  async update(
    id: string,
    dto: UpdateShopDto,
    actorId: string | null,
  ): Promise<ShopRow> {
    const sets: string[] = [];
    const params: unknown[] = [];
    const set = (column: string, value: unknown) => {
      params.push(value);
      sets.push(`${column} = $${params.length}`);
    };

    if (dto.name !== undefined) set('name', dto.name);
    if (dto.description !== undefined) set('description', dto.description);
    if (dto.isActive !== undefined) set('is_active', dto.isActive);
    if (sets.length === 0) return this.findOne(id);

    set('updated_by_id', actorId);
    params.push(id);

    const updated: unknown = await this.dataSource.query(
      `UPDATE shops SET ${sets.join(', ')} WHERE id = $${params.length} RETURNING id`,
      params,
    );
    if (affectedRows(updated) === 0)
      throw new NotFoundException('No such shop.');
    return this.findOne(id);
  }

  /**
   * BR-48 — a shop holding any customer, inventory item or sale cannot be
   * deleted. Deletion exists only for a shop created in error and never used.
   *
   * The database enforces it with `ON DELETE RESTRICT` on all three child
   * tables (and on `users.shop_id`, added with the home-shop feature), so this
   * check is a courtesy that explains *what* is in the way. FR-11.2.3 makes
   * deactivating the normal way to retire a shop.
   */
  async remove(id: string): Promise<void> {
    const shop = await this.findOne(id);
    const holdings: string[] = [];
    if (Number(shop.customer_count) > 0)
      holdings.push(`${shop.customer_count} customer(s)`);
    if (Number(shop.inventory_count) > 0)
      holdings.push(`${shop.inventory_count} product(s)`);
    if (Number(shop.sale_count) > 0)
      holdings.push(`${shop.sale_count} sale(s)`);
    if (Number(shop.staff_count) > 0)
      holdings.push(`${shop.staff_count} staff account(s)`);

    if (holdings.length > 0) {
      throw new ConflictException(
        `"${shop.name}" holds ${holdings.join(', ')} and cannot be deleted. ` +
          `Deactivate it instead — its history stays intact and continues to ` +
          `appear in reports (BR-48, FR-11.2.3).`,
      );
    }

    const deleted: unknown = await this.dataSource.query(
      `DELETE FROM shops WHERE id = $1 RETURNING id`,
      [id],
    );
    if (affectedRows(deleted) === 0)
      throw new NotFoundException('No such shop.');
  }
}
