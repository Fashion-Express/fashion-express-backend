import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, EntityManager } from 'typeorm';
import { Decimal } from '../../common/decimal';
import { nextSaleNumber } from '../../common/identifiers';
import { PAGE_SIZE, type Page, toPage } from '../../common/pagination';
import { affectedRows, firstRow, rowsOf } from '../../common/sql';
import { TransactionService } from '../../common/transaction';
import type { AuthUser } from '../auth/auth-user';
import { SalePaymentsService } from './sale-payments.service';
import type {
  CreateSaleDto,
  ListSalesQuery,
  SaleItemDto,
  UpdateSaleDto,
} from './dto';
import { itemType, saleStatus } from './status';

export interface SaleRow {
  id: string;
  sale_number: string;
  status_code: string;
  status_label: string;
  total_amount: string;
  amount_paid: string;
  balance_due: string;
  notes: string;
  finalized_at: string | null;
  created_at: string;
  customer_id: string;
  customer_name: string;
  customer_number: string;
  shop_id: string;
  shop_name: string;
  created_by: string | null;
  created_by_id: string | null;
}

const SELECT_SALE = `
  SELECT s.id::text, s.sale_number, s.status_code, st.label AS status_label,
         s.total_amount::text, s.amount_paid::text,
         (s.total_amount - s.amount_paid)::text AS balance_due,
         s.notes, s.finalized_at, s.created_at,
         s.customer_id::text, c.name AS customer_name, c.customer_id AS customer_number,
         s.shop_id::text, sh.name AS shop_name,
         u.username AS created_by, s.created_by_id::text
    FROM sales s
    JOIN statuses st ON st.id = s.status_id AND st.scope = 'sale'
    JOIN customers c ON c.id = s.customer_id
    JOIN shops sh    ON sh.id = s.shop_id
    LEFT JOIN users u ON u.id = s.created_by_id`;

@Injectable()
export class SalesService {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly transactions: TransactionService,
    private readonly payments: SalePaymentsService,
  ) {}

  /**
   * BR-01 — a user who is not a manager or superuser may see **only the sales
   * they created**. This applies uniformly to the list, every detail page, all
   * documents and all exports: *"there is no route by which a non-manager can
   * read another user's sale."*
   *
   * It is not a guard. A guard decides whether a request may proceed, not which
   * rows it returns, so this returns a WHERE fragment that every read path must
   * include — and `findOne` uses it too, so a direct fetch by id is scoped as
   * tightly as the list.
   */
  private visibility(user: AuthUser, params: unknown[]): string | null {
    if (user.isSuperuser || user.isManager) return null;
    params.push(user.id);
    return `s.created_by_id = $${params.length}`;
  }

  async list(
    query: ListSalesQuery,
    user: AuthUser,
  ): Promise<Page<SaleRow> & { totals: Record<string, string> }> {
    const where: string[] = [];
    const params: unknown[] = [];

    const scope = this.visibility(user, params);
    if (scope) where.push(scope);

    if (query.search) {
      params.push(`%${query.search}%`);
      const n = params.length;
      where.push(
        `(s.sale_number ILIKE $${n} OR c.name ILIKE $${n} OR c.customer_id ILIKE $${n})`,
      );
    }
    if (query.status) {
      params.push(query.status);
      where.push(`s.status_code = $${params.length}`);
    }
    if (query.shopId) {
      params.push(query.shopId);
      where.push(`s.shop_id = $${params.length}`);
    }
    if (query.customerId) {
      params.push(query.customerId);
      where.push(`s.customer_id = $${params.length}`);
    }
    if (query.createdFrom) {
      params.push(query.createdFrom);
      where.push(`s.created_at >= $${params.length}`);
    }
    if (query.createdTo) {
      params.push(query.createdTo);
      where.push(`s.created_at < ($${params.length}::date + 1)`);
    }
    /**
     * FR-00.5 — the manager's "created by" filter. It is applied *in addition*
     * to the visibility scope above, never instead of it, so a non-manager
     * passing someone else's id gets nothing rather than their sales.
     */
    if (query.createdById) {
      params.push(query.createdById);
      where.push(`s.created_by_id = $${params.length}`);
    }
    if (query.itemType) {
      params.push(query.itemType);
      where.push(
        `EXISTS (SELECT 1 FROM sale_items i
                  WHERE i.sale_id = s.id AND i.item_type_code = $${params.length})`,
      );
    }

    const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const size = PAGE_SIZE.sales;
    const page = query.page && query.page > 0 ? query.page : 1;

    const counted = firstRow<{ count: string }>(
      await this.dataSource.query(
        `SELECT count(*)::text AS count
           FROM sales s JOIN customers c ON c.id = s.customer_id ${clause}`,
        params,
      ),
    );

    const rows = rowsOf<SaleRow>(
      await this.dataSource.query(
        `${SELECT_SALE} ${clause} ORDER BY s.created_at DESC
          LIMIT ${size} OFFSET ${(page - 1) * size}`,
        params,
      ),
    );

    return {
      ...toPage(rows, Number(counted?.count ?? '0'), page, size),
      totals: await this.totals(clause, params, query.itemType),
    };
  }

  /**
   * FR-02.8 — the running totals above the list, respecting every filter.
   *
   * BR-03 — drafts and quotations are excluded from revenue and dues wherever
   * those totals appear, so the sums are confined to finalised sales even when
   * the list itself is showing drafts.
   *
   * BR-15 — when filtering by item kind the totals are **apportioned**: a mixed
   * order contributes only the value of its matching lines, and the received
   * amount is pro-rated by that line share. A sale half machines and half stock
   * with everything paid contributes half its receipts to a stock-only view.
   */
  private async totals(
    clause: string,
    params: unknown[],
    itemTypeFilter?: string,
  ): Promise<Record<string, string>> {
    if (!itemTypeFilter) {
      const row = firstRow<Record<string, string>>(
        await this.dataSource.query(
          `SELECT COALESCE(SUM(s.total_amount) FILTER (WHERE s.status_code = 'finalized'), 0)::text AS invoiced,
                  COALESCE(SUM(s.amount_paid)  FILTER (WHERE s.status_code = 'finalized'), 0)::text AS received,
                  COALESCE(SUM(s.total_amount - s.amount_paid)
                           FILTER (WHERE s.status_code = 'finalized'), 0)::text AS outstanding
             FROM sales s JOIN customers c ON c.id = s.customer_id ${clause}`,
          params,
        ),
      )!;
      return row;
    }

    const row = firstRow<Record<string, string>>(
      await this.dataSource.query(
        `WITH matched AS (
           SELECT s.id,
                  s.total_amount,
                  s.amount_paid,
                  COALESCE(SUM(i.line_total) FILTER (WHERE i.item_type_code = $${params.length}), 0) AS matched_value,
                  COALESCE(SUM(i.line_total), 0) AS sale_value
             FROM sales s
             JOIN customers c ON c.id = s.customer_id
             LEFT JOIN sale_items i ON i.sale_id = s.id
             ${clause}
              AND s.status_code = 'finalized'
            GROUP BY s.id, s.total_amount, s.amount_paid
         )
         SELECT COALESCE(SUM(matched_value), 0)::text AS invoiced,
                -- receipts pro-rated by the matching lines' share of the sale
                round(COALESCE(SUM(
                  CASE WHEN sale_value > 0
                       THEN amount_paid * (matched_value / sale_value)
                       ELSE 0 END), 0), 2)::text AS received,
                round(COALESCE(SUM(
                  matched_value - CASE WHEN sale_value > 0
                       THEN amount_paid * (matched_value / sale_value)
                       ELSE 0 END), 0), 2)::text AS outstanding
           FROM matched`,
        params,
      ),
    )!;
    return row;
  }

  async findOne(id: string, user: AuthUser): Promise<SaleRow> {
    const params: unknown[] = [id];
    const scope = this.visibility(user, params);
    const row = firstRow<SaleRow>(
      await this.dataSource.query(
        `${SELECT_SALE} WHERE s.id = $1${scope ? ` AND ${scope}` : ''}`,
        params,
      ),
    );
    // A sale the caller may not see is reported as missing rather than
    // forbidden: "there is no route by which a non-manager can read another
    // user's sale" includes learning that it exists.
    if (!row) throw new NotFoundException('No such sale.');
    return row;
  }

  async items(
    saleId: string,
    user: AuthUser,
  ): Promise<Array<Record<string, unknown>>> {
    await this.findOne(saleId, user);
    return rowsOf(
      await this.dataSource.query(
        `SELECT i.id::text, i.item_type_code, t.label AS item_type_label,
                i.inventory_item_id::text, inv.part_code, inv.part_name,
                i.description, i.quantity::text, i.boxes,
                i.unit_price::text, i.line_total::text
           FROM sale_items i
           JOIN item_types t ON t.id = i.item_type_id
           LEFT JOIN inventory_items inv ON inv.id = i.inventory_item_id
          WHERE i.sale_id = $1
          ORDER BY i.id`,
        [saleId],
      ),
    );
  }

  /**
   * FR-02.2 — customer, lines and an optional first payment in one submission.
   *
   * BR-02 — stock is untouched here whatever the state. Quotations and drafts
   * may be edited freely without disturbing the warehouse; only finalisation
   * moves stock.
   */
  async create(dto: CreateSaleDto, user: AuthUser): Promise<SaleRow> {
    const id = await this.transactions.run(async (manager) => {
      const status = await saleStatus(manager, dto.status ?? 'draft');
      const saleNumber = await nextSaleNumber(manager);

      const inserted: unknown = await manager.query(
        `INSERT INTO sales (sale_number, shop_id, customer_id, status_id, status_code,
                            notes, created_by_id, updated_by_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $7)
         RETURNING id::text`,
        [
          saleNumber,
          dto.shopId,
          dto.customerId,
          status.id,
          status.code,
          dto.notes ?? '',
          user.id,
        ],
      );
      const saleId = firstRow<{ id: string }>(inserted)!.id;

      for (const item of dto.items) {
        await this.insertItem(manager, saleId, dto.shopId, item);
      }

      if (dto.initialPayment) {
        // BR-11 — a quotation cannot take payment.
        if (status.code === 'quote') {
          throw new BadRequestException(
            'A quotation cannot take a payment (BR-11). Convert it to an invoice first.',
          );
        }
        await this.payments.write(manager, saleId, dto.initialPayment, user.id);
      }

      return saleId;
    });

    return this.findOne(id, user);
  }

  /**
   * Insert one line, resolving the price and pinning the shop.
   *
   * `shop_id` is copied from the sale, never taken from the caller: the two
   * composite foreign keys on `sale_items` use it to prove the line's sale and
   * its product are in the same shop (BR-50), and letting a user choose it
   * would defeat that.
   */
  async insertItem(
    manager: EntityManager,
    saleId: string,
    shopId: string,
    item: SaleItemDto,
  ): Promise<void> {
    const type = await itemType(manager, item.itemType);

    let unitPrice = item.unitPrice ?? '0';
    let description = item.description ?? '';

    if (type.code === 'inventory') {
      if (!item.inventoryItemId) {
        throw new BadRequestException(
          'A stocked line must reference an inventory item (BR-04).',
        );
      }
      const product = firstRow<{
        part_code: string;
        part_name: string;
        unit_price: string;
      }>(
        await manager.query(
          `SELECT part_code, part_name, unit_price::text
             FROM inventory_items WHERE id = $1`,
          [item.inventoryItemId],
        ),
      );
      if (!product) throw new BadRequestException('No such product.');

      /**
       * FR-02.2 — a stocked line saved with a zero or blank price takes the
       * product's current selling price. A *positive* entered price always
       * wins, so an intentional discount survives and an empty field does not
       * silently sell at nothing.
       */
      if (new Decimal(unitPrice).lessThanOrEqualTo(0)) {
        unitPrice = product.unit_price;
      }

      // The invoice keeps reading correctly if the product is later renamed.
      if (!description) {
        description = `${product.part_name} (${product.part_code})`;
      }
    } else {
      if (!description.trim()) {
        throw new BadRequestException(
          'A machine line must carry a description (BR-04).',
        );
      }
    }

    await manager.query(
      `INSERT INTO sale_items (sale_id, shop_id, item_type_id, item_type_code,
                               inventory_item_id, description, quantity, boxes, unit_price)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [
        saleId,
        shopId,
        type.id,
        type.code,
        type.code === 'inventory' ? item.inventoryItemId : null,
        description,
        item.quantity,
        item.boxes ?? 0,
        unitPrice,
      ],
    );
  }

  async update(
    id: string,
    dto: UpdateSaleDto,
    user: AuthUser,
  ): Promise<SaleRow> {
    const sale = await this.findOne(id, user);

    if (dto.status !== undefined && dto.status !== sale.status_code) {
      await this.setStatus(id, dto.status, sale.status_code);
    }
    if (dto.notes !== undefined) {
      await this.dataSource.query(
        `UPDATE sales SET notes = $1, updated_by_id = $2 WHERE id = $3`,
        [dto.notes, user.id, id],
      );
    }
    return this.findOne(id, user);
  }

  /**
   * The state transitions the workflow allows.
   *
   * Finalising is not here: it is its own act with its own permission and its
   * own atomic stock work (FR-02.4). And nothing leaves `finalized` — a
   * finalised sale has moved stock and begun counting toward revenue, so
   * reverting it happens only through FR-02.6.2, when its last line is removed.
   */
  private async setStatus(
    id: string,
    next: string,
    current: string,
  ): Promise<void> {
    if (current === 'finalized') {
      throw new BadRequestException(
        'A finalised sale cannot change state. Stock has been issued against it.',
      );
    }
    if (next === 'finalized') {
      throw new BadRequestException(
        'Use POST /api/sales/:id/finalize — finalising validates and deducts stock.',
      );
    }

    await this.transactions.run(async (manager) => {
      const status = await saleStatus(
        manager,
        next as 'draft' | 'quote' | 'cancelled',
      );
      await manager.query(
        `UPDATE sales SET status_id = $1, status_code = $2 WHERE id = $3`,
        [status.id, status.code, id],
      );
    });
  }

  /**
   * FR-02.3.1 — a quotation becomes an invoice in one step, keeping its items
   * and prices, and follows the normal draft flow from there.
   */
  async convertQuotation(id: string, user: AuthUser): Promise<SaleRow> {
    const sale = await this.findOne(id, user);
    if (sale.status_code !== 'quote') {
      throw new BadRequestException('Only a quotation can be converted.');
    }
    await this.setStatus(id, 'draft', 'quote');
    return this.findOne(id, user);
  }

  /** BR-14 — only draft sales may be deleted. */
  async remove(id: string, user: AuthUser): Promise<void> {
    const sale = await this.findOne(id, user);
    if (sale.status_code !== 'draft') {
      throw new BadRequestException(
        `Only draft sales may be deleted (BR-14). This one is ${sale.status_label}.`,
      );
    }
    const deleted: unknown = await this.dataSource.query(
      `DELETE FROM sales WHERE id = $1 RETURNING id`,
      [id],
    );
    if (affectedRows(deleted) === 0)
      throw new NotFoundException('No such sale.');
  }

  /** Shared by the paths that may only act on a sale the caller can see. */
  async assertVisible(id: string, user: AuthUser): Promise<SaleRow> {
    return this.findOne(id, user);
  }

  /** FR-02.6.1 — adding or removing a line on a finalised sale is admin-only. */
  assertMayEditFinalised(user: AuthUser): void {
    if (!user.isSuperuser) {
      throw new ForbiddenException(
        'Editing the lines of a finalised sale is restricted to administrators (FR-02.6.1).',
      );
    }
  }
}
