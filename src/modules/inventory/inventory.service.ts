import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { Decimal } from '../../common/decimal';
import { PAGE_SIZE, type Page, toPage } from '../../common/pagination';
import { affectedRows, firstRow, rowsOf } from '../../common/sql';
import { TransactionService } from '../../common/transaction';
import type {
  CreateInventoryItemDto,
  ListInventoryQuery,
  UpdateInventoryItemDto,
} from './dto';
import { StockHistoryService } from './stock-history.service';

export interface InventoryRow {
  id: string;
  part_code: string;
  part_name: string;
  description: string;
  location: string;
  quantity: string;
  box_count: number;
  purchase_price: string | null;
  unit_price: string;
  minimum_stock: number;
  is_low_stock: boolean;
  stock_value: string;
  shop_id: string;
  shop_name: string;
  unit_code: string;
  unit_label: string;
  category_id: string | null;
  category_name: string | null;
  supplier_id: string | null;
  supplier_name: string | null;
}

/**
 * BR-24 — an item is low when its quantity is at or below its own minimum.
 * That single definition drives every low-stock warning in the system, and it
 * is computed here rather than repeated at each call site.
 */
const SELECT_ITEM = `
  SELECT i.id::text, i.part_code, i.part_name, i.description, i.location,
         i.quantity::text, i.box_count,
         i.purchase_price::text, i.unit_price::text, i.minimum_stock,
         (i.quantity <= i.minimum_stock) AS is_low_stock,
         -- quantity is numeric(14,3) and price numeric(14,2), so the product
         -- carries five decimals. Money is two (NFR-01), so round at the money
         -- scale rather than leaking the intermediate precision to callers.
         round(i.quantity * i.unit_price, 2)::text AS stock_value,
         i.shop_id::text, sh.name AS shop_name,
         u.code AS unit_code, u.label AS unit_label,
         i.category_id::text, c.name AS category_name,
         i.supplier_id::text, sup.name AS supplier_name
    FROM inventory_items i
    JOIN shops sh ON sh.id = i.shop_id
    JOIN units u  ON u.id = i.unit_id
    LEFT JOIN categories c   ON c.id = i.category_id
    LEFT JOIN suppliers  sup ON sup.id = i.supplier_id`;

@Injectable()
export class InventoryService {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly transactions: TransactionService,
    private readonly history: StockHistoryService,
  ) {}

  private buildWhere(query: ListInventoryQuery): {
    clause: string;
    params: unknown[];
  } {
    const where: string[] = [];
    const params: unknown[] = [];

    if (query.search) {
      params.push(`%${query.search}%`);
      const n = params.length;
      where.push(
        `(i.part_name ILIKE $${n} OR i.part_code ILIKE $${n} OR c.name ILIKE $${n})`,
      );
    }
    if (query.shopId) {
      params.push(query.shopId);
      where.push(`i.shop_id = $${params.length}`);
    }
    if (query.categoryId) {
      params.push(query.categoryId);
      where.push(`i.category_id = $${params.length}`);
    }
    // BR-52 — low stock is evaluated per shop, which the shop filter above
    // supplies; the comparison itself is always item-against-its-own-minimum.
    if (query.lowStock) where.push(`i.quantity <= i.minimum_stock`);

    return {
      clause: where.length ? `WHERE ${where.join(' AND ')}` : '',
      params,
    };
  }

  async list(
    query: ListInventoryQuery,
  ): Promise<Page<InventoryRow> & { summary: Record<string, string> }> {
    const { clause, params } = this.buildWhere(query);
    const size = PAGE_SIZE.inventory;
    const page = query.page && query.page > 0 ? query.page : 1;

    /**
     * FR-04.4 — the summary bar reports for the **current filter**, not for the
     * current page. Same WHERE, no LIMIT.
     */
    const summary = firstRow<Record<string, string>>(
      await this.dataSource.query(
        `SELECT count(*)::text                              AS product_count,
                COALESCE(SUM(i.quantity), 0)::text          AS total_quantity,
                COALESCE(SUM(i.box_count), 0)::text         AS total_boxes,
                round(COALESCE(SUM(i.quantity * i.unit_price), 0), 2)::text AS total_value,
                count(*) FILTER (WHERE i.quantity <= i.minimum_stock)::text AS low_stock_count
           FROM inventory_items i
           LEFT JOIN categories c ON c.id = i.category_id
           ${clause}`,
        params,
      ),
    )!;

    const rows = rowsOf<InventoryRow>(
      await this.dataSource.query(
        `${SELECT_ITEM} ${clause} ORDER BY i.part_name
          LIMIT ${size} OFFSET ${(page - 1) * size}`,
        params,
      ),
    );

    return {
      ...toPage(rows, Number(summary.product_count), page, size),
      summary,
    };
  }

  /**
   * FR-02.2.1 — the line-item picker for a sale, confined to one shop.
   *
   * Offering another shop's stock would produce a save the database refuses
   * (BR-50), so the shop is required.
   */
  async options(shopId: string): Promise<Array<Record<string, unknown>>> {
    return rowsOf(
      await this.dataSource.query(
        `SELECT i.id::text, i.part_code, i.part_name, i.quantity::text,
                i.box_count, i.unit_price::text, u.label AS unit_label
           FROM inventory_items i JOIN units u ON u.id = i.unit_id
          WHERE i.shop_id = $1
          ORDER BY i.part_name`,
        [shopId],
      ),
    );
  }

  /** FR-01.5 — the low-stock list, optionally for one shop (BR-52). */
  async lowStock(
    shopId?: string,
    limit = 5,
  ): Promise<Array<Record<string, unknown>>> {
    const params: unknown[] = [];
    let clause = 'WHERE i.quantity <= i.minimum_stock';
    if (shopId) {
      params.push(shopId);
      clause += ` AND i.shop_id = $${params.length}`;
    }
    return rowsOf(
      await this.dataSource.query(
        `${SELECT_ITEM} ${clause} ORDER BY i.quantity LIMIT ${limit}`,
        params,
      ),
    );
  }

  async findOne(id: string): Promise<InventoryRow> {
    const row = firstRow<InventoryRow>(
      await this.dataSource.query(`${SELECT_ITEM} WHERE i.id = $1`, [id]),
    );
    if (!row) throw new NotFoundException('No such product.');
    return row;
  }

  /**
   * Creating a product, and its opening movement.
   *
   * FR-04.5.1 — a product created with stock records a **Stock In** movement
   * reasoned "Initial stock". Created with nothing, it records none: a movement
   * log should describe movements, not creations.
   */
  async create(
    dto: CreateInventoryItemDto,
    actorId: string | null,
  ): Promise<InventoryRow> {
    const id = await this.transactions.run(async (manager) => {
      const inserted: unknown = await manager.query(
        `INSERT INTO inventory_items
           (shop_id, part_code, part_name, description, location,
            category_id, unit_id, supplier_id,
            quantity, box_count, purchase_price, unit_price, minimum_stock,
            created_by_id, updated_by_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $14)
         RETURNING id::text`,
        [
          dto.shopId,
          dto.partCode,
          dto.partName,
          dto.description ?? '',
          dto.location ?? '',
          dto.categoryId ?? null,
          dto.unitId,
          dto.supplierId ?? null,
          dto.quantity ?? '0',
          dto.boxCount ?? 0,
          dto.purchasePrice ?? null,
          dto.unitPrice ?? '0',
          dto.minimumStock ?? 10,
          actorId,
        ],
      );
      const newId = firstRow<{ id: string }>(inserted)!.id;

      await this.history.record(manager, {
        itemId: newId,
        type: 'in',
        reason: 'Initial stock',
        actorId,
        units: { previous: '0', next: dto.quantity ?? '0' },
        boxes: { previous: 0, next: dto.boxCount ?? 0 },
      });

      return newId;
    });

    return this.findOne(id);
  }

  /**
   * Editing a product, and the movements an edit implies.
   *
   * FR-04.5.1 fixes the vocabulary and it is not symmetrical: raising the
   * quantity is a **Stock In** reasoned "Stock added via edit", but lowering it
   * is an **Adjustment** reasoned "Stock adjusted via edit". Stock leaving
   * through an edit is a correction, not an issue — an issue is a sale.
   */
  async update(
    id: string,
    dto: UpdateInventoryItemDto,
    actorId: string | null,
  ): Promise<InventoryRow> {
    await this.transactions.run(async (manager) => {
      const before = firstRow<{ quantity: string; box_count: number }>(
        await manager.query(
          `SELECT quantity::text, box_count FROM inventory_items WHERE id = $1 FOR UPDATE`,
          [id],
        ),
      );
      if (!before) throw new NotFoundException('No such product.');

      const sets: string[] = [];
      const params: unknown[] = [];
      const set = (column: string, value: unknown) => {
        params.push(value);
        sets.push(`${column} = $${params.length}`);
      };

      if (dto.partCode !== undefined) set('part_code', dto.partCode);
      if (dto.partName !== undefined) set('part_name', dto.partName);
      if (dto.description !== undefined) set('description', dto.description);
      if (dto.location !== undefined) set('location', dto.location);
      if (dto.unitId !== undefined) set('unit_id', dto.unitId);
      if (dto.categoryId !== undefined) set('category_id', dto.categoryId);
      if (dto.supplierId !== undefined) set('supplier_id', dto.supplierId);
      if (dto.quantity !== undefined) set('quantity', dto.quantity);
      if (dto.boxCount !== undefined) set('box_count', dto.boxCount);
      if (dto.purchasePrice !== undefined)
        set('purchase_price', dto.purchasePrice);
      if (dto.unitPrice !== undefined) set('unit_price', dto.unitPrice);
      if (dto.minimumStock !== undefined)
        set('minimum_stock', dto.minimumStock);

      if (sets.length === 0) return;

      set('updated_by_id', actorId);
      params.push(id);
      await manager.query(
        `UPDATE inventory_items SET ${sets.join(', ')} WHERE id = $${params.length}`,
        params,
      );

      const nextQuantity = dto.quantity ?? before.quantity;
      const nextBoxes = dto.boxCount ?? before.box_count;

      const unitsRose = new Decimal(nextQuantity).greaterThan(before.quantity);
      const boxesRose = nextBoxes > before.box_count;

      // Units and boxes can move in opposite directions in one edit, so each
      // dimension is recorded with the type its own change implies (BR-26).
      if (!new Decimal(nextQuantity).equals(before.quantity)) {
        await this.history.record(manager, {
          itemId: id,
          type: unitsRose ? 'in' : 'adjustment',
          reason: unitsRose
            ? 'Stock added via edit'
            : 'Stock adjusted via edit',
          actorId,
          units: { previous: before.quantity, next: nextQuantity },
        });
      }
      if (nextBoxes !== before.box_count) {
        await this.history.record(manager, {
          itemId: id,
          type: boxesRose ? 'in' : 'adjustment',
          reason: boxesRose
            ? 'Stock added via edit'
            : 'Stock adjusted via edit',
          actorId,
          boxes: { previous: before.box_count, next: nextBoxes },
        });
      }
    });

    return this.findOne(id);
  }

  /**
   * BR-27 — a product that has ever appeared on a sale must not be deletable in
   * a way that destroys the sale's record of what was sold.
   *
   * `ON DELETE RESTRICT` on `sale_items.inventory_item_id` is the guarantee;
   * this check explains it before the constraint has to.
   */
  async remove(id: string): Promise<void> {
    const sold = firstRow<{ n: string }>(
      await this.dataSource.query(
        `SELECT count(*)::text AS n FROM sale_items WHERE inventory_item_id = $1`,
        [id],
      ),
    );
    if (Number(sold?.n ?? '0') > 0) {
      throw new ConflictException(
        `This product appears on ${sold!.n} sale line(s) and cannot be deleted — ` +
          `doing so would destroy the record of what was shipped (BR-27).`,
      );
    }

    const deleted: unknown = await this.dataSource.query(
      `DELETE FROM inventory_items WHERE id = $1 RETURNING id`,
      [id],
    );
    if (affectedRows(deleted) === 0)
      throw new NotFoundException('No such product.');
  }

  /** FR-04.5 — the movement history for one product, newest first. */
  movements(
    itemId: string,
    page: number,
  ): Promise<{
    items: Array<Record<string, unknown>>;
    total: number;
    page: number;
    pageSize: number;
  }> {
    return this.history.forItem(itemId, page);
  }
}
