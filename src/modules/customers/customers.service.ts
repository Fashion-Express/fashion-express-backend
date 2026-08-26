import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, EntityManager } from 'typeorm';
import { nextCustomerId } from '../../common/identifiers';
import { PAGE_SIZE, type Page, toPage } from '../../common/pagination';
import { affectedRows, firstRow, rowsOf } from '../../common/sql';
import { TransactionService } from '../../common/transaction';
import type {
  CreateCustomerDto,
  ListCustomersQuery,
  UpdateCustomerDto,
} from './dto';

export interface CustomerRow {
  id: string;
  customer_id: string;
  name: string;
  company: string;
  email: string;
  phone: string;
  address: string;
  city: string;
  notes: string;
  status_code: string;
  status_label: string;
  shop_id: string;
  shop_name: string;
}

const SELECT_CUSTOMER = `
  SELECT c.id::text, c.customer_id, c.name, c.company, c.email, c.phone,
         c.address, c.city, c.notes,
         st.code AS status_code, st.label AS status_label,
         c.shop_id::text, sh.name AS shop_name
    FROM customers c
    JOIN statuses st ON st.id = c.status_id AND st.scope = 'customer'
    JOIN shops    sh ON sh.id = c.shop_id`;

@Injectable()
export class CustomersService {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly transactions: TransactionService,
  ) {}

  async list(query: ListCustomersQuery): Promise<Page<CustomerRow>> {
    const where: string[] = [];
    const params: unknown[] = [];

    if (query.search) {
      params.push(`%${query.search}%`);
      const n = params.length;
      where.push(
        `(c.name ILIKE $${n} OR c.customer_id ILIKE $${n}
          OR c.company ILIKE $${n} OR c.phone ILIKE $${n})`,
      );
    }
    if (query.statusCode) {
      params.push(query.statusCode);
      where.push(`st.code = $${params.length}`);
    }
    if (query.shopId) {
      params.push(query.shopId);
      where.push(`c.shop_id = $${params.length}`);
    }

    const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const size = PAGE_SIZE.customers;
    const page = query.page && query.page > 0 ? query.page : 1;

    const counted = firstRow<{ count: string }>(
      await this.dataSource.query(
        `SELECT count(*)::text AS count FROM customers c
           JOIN statuses st ON st.id = c.status_id AND st.scope = 'customer'
           ${clause}`,
        params,
      ),
    );

    const rows = rowsOf<CustomerRow>(
      await this.dataSource.query(
        `${SELECT_CUSTOMER} ${clause} ORDER BY c.created_at DESC
          LIMIT ${size} OFFSET ${(page - 1) * size}`,
        params,
      ),
    );

    return toPage(rows, Number(counted?.count ?? '0'), page, size);
  }

  /**
   * FR-02.2.1 — the customer picker on a sale form, confined to one shop.
   *
   * A sale's customer must belong to the sale's shop (BR-53), so offering
   * anyone else would produce a save the database refuses. The shop is
   * required for exactly that reason.
   */
  async options(shopId: string): Promise<Array<{ id: string; label: string }>> {
    return rowsOf(
      await this.dataSource.query(
        `SELECT c.id::text, c.name || ' (' || c.customer_id || ')' AS label
           FROM customers c
           JOIN statuses st ON st.id = c.status_id AND st.scope = 'customer'
          WHERE c.shop_id = $1 AND st.code = 'active'
          ORDER BY c.name`,
        [shopId],
      ),
    );
  }

  async findOne(id: string): Promise<CustomerRow> {
    const row = firstRow<CustomerRow>(
      await this.dataSource.query(`${SELECT_CUSTOMER} WHERE c.id = $1`, [id]),
    );
    if (!row) throw new NotFoundException('No such customer.');
    return row;
  }

  /**
   * FR-03.2 — the customer number is issued here and never accepted from the
   * caller.
   *
   * It runs inside the transaction that inserts the row so that a rollback
   * returns the number: the serial is continuous and does not restart (BR-46),
   * and a gap would invite the question of what was deleted.
   */
  async create(
    dto: CreateCustomerDto,
    actorId: string | null,
  ): Promise<CustomerRow> {
    const id = await this.transactions.run(async (manager) => {
      const statusId = await this.statusId(manager, dto.statusCode ?? 'active');
      const customerId = await nextCustomerId(manager);

      const inserted: unknown = await manager.query(
        `INSERT INTO customers (customer_id, shop_id, name, company, email, phone,
                                address, city, notes, status_id,
                                created_by_id, updated_by_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $11)
         RETURNING id::text`,
        [
          customerId,
          dto.shopId,
          dto.name,
          dto.company ?? '',
          dto.email ?? '',
          dto.phone,
          dto.address ?? '',
          dto.city ?? '',
          dto.notes ?? '',
          statusId,
          actorId,
        ],
      );
      return firstRow<{ id: string }>(inserted)!.id;
    });

    return this.findOne(id);
  }

  async update(
    id: string,
    dto: UpdateCustomerDto,
    actorId: string | null,
  ): Promise<CustomerRow> {
    const sets: string[] = [];
    const params: unknown[] = [];
    const set = (column: string, value: unknown) => {
      params.push(value);
      sets.push(`${column} = $${params.length}`);
    };

    for (const [key, column] of [
      ['name', 'name'],
      ['company', 'company'],
      ['email', 'email'],
      ['phone', 'phone'],
      ['address', 'address'],
      ['city', 'city'],
      ['notes', 'notes'],
    ] as const) {
      if (dto[key] !== undefined) set(column, dto[key]);
    }
    if (dto.statusCode !== undefined) {
      set(
        'status_id',
        await this.statusId(this.dataSource.manager, dto.statusCode),
      );
    }
    if (sets.length === 0) return this.findOne(id);

    set('updated_by_id', actorId);
    params.push(id);

    const updated: unknown = await this.dataSource.query(
      `UPDATE customers SET ${sets.join(', ')} WHERE id = $${params.length} RETURNING id`,
      params,
    );
    if (affectedRows(updated) === 0) {
      throw new NotFoundException('No such customer.');
    }
    return this.findOne(id);
  }

  /**
   * FR-03.6.1 — what deleting this customer would destroy.
   *
   * Deletion cascades to their sales, line items, payments, payment batches and
   * allocations (BR-21): no orphaned financial record may survive its customer.
   * That is a large, irreversible act, so the confirmation screen counts it
   * first and the client must acknowledge the loss.
   */
  async deletionImpact(id: string): Promise<{
    customer: CustomerRow;
    sales: number;
    salePayments: number;
    paymentBatches: number;
    totalInvoiced: string;
    totalReceived: string;
  }> {
    const customer = await this.findOne(id);

    const counts = firstRow<{
      sales: string;
      sale_payments: string;
      batches: string;
      invoiced: string;
      received: string;
    }>(
      await this.dataSource.query(
        `SELECT
           (SELECT count(*)::text FROM sales WHERE customer_id = $1) AS sales,
           (SELECT count(*)::text FROM sale_payments p
              JOIN sales s ON s.id = p.sale_id WHERE s.customer_id = $1) AS sale_payments,
           (SELECT count(*)::text FROM customer_payment_batches
             WHERE customer_id = $1) AS batches,
           (SELECT COALESCE(SUM(total_amount), 0)::text FROM sales
             WHERE customer_id = $1 AND status_code = 'finalized') AS invoiced,
           (SELECT COALESCE(SUM(amount_paid), 0)::text FROM sales
             WHERE customer_id = $1 AND status_code = 'finalized') AS received`,
        [id],
      ),
    )!;

    return {
      customer,
      sales: Number(counts.sales),
      salePayments: Number(counts.sale_payments),
      paymentBatches: Number(counts.batches),
      // BR-03 — drafts and quotations are excluded from every total.
      totalInvoiced: counts.invoiced,
      totalReceived: counts.received,
    };
  }

  async remove(id: string): Promise<void> {
    const deleted: unknown = await this.dataSource.query(
      `DELETE FROM customers WHERE id = $1 RETURNING id`,
      [id],
    );
    if (affectedRows(deleted) === 0) {
      throw new NotFoundException('No such customer.');
    }
  }

  private async statusId(
    manager: EntityManager,
    code: string,
  ): Promise<string> {
    const row = firstRow<{ id: string }>(
      await manager.query(
        `SELECT id::text FROM statuses WHERE scope = 'customer' AND code = $1`,
        [code],
      ),
    );
    if (!row)
      throw new BadRequestException(`Unknown customer status "${code}".`);
    return row.id;
  }
}
