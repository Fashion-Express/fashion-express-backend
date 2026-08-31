import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, EntityManager } from 'typeorm';
import {
  SUPPLIER_CONTACTS,
  assertContactsAreFree,
} from '../../common/contact-uniqueness';
import { Decimal } from '../../common/decimal';
import { supplierPaymentNumber } from '../../common/identifiers';
import { PAGE_SIZE, type Page, toPage } from '../../common/pagination';
import { affectedRows, firstRow, rowsOf } from '../../common/sql';
import { lockRow, TransactionService } from '../../common/transaction';
import { LedgerService } from '../ledger/ledger.service';
import type {
  CreatePurchaseDto,
  CreatePurchasePaymentDto,
  CreateSupplierDto,
  ListSuppliersQuery,
  SupplierPaymentDto,
  UpdatePurchaseDto,
  UpdatePurchasePaymentDto,
  UpdateSupplierDto,
} from './dto';

export interface SupplierRow {
  id: string;
  name: string;
  address: string;
  phone: string;
  email: string;
  total_purchased: string;
  total_paid: string;
  total_due: string;
  purchase_count: string;
}

/**
 * FR-05.2 / FR-05.4 — total purchased, paid and outstanding per supplier.
 *
 * `paid_amount` is maintained by the rollup trigger (§11), so these sums are
 * over a column that is always true rather than over the payment rows.
 */
const SELECT_SUPPLIER = `
  SELECT s.id::text, s.name, s.address, s.phone, s.email,
         COALESCE(agg.purchased, 0)::text  AS total_purchased,
         COALESCE(agg.paid, 0)::text       AS total_paid,
         COALESCE(agg.purchased - agg.paid, 0)::text AS total_due,
         COALESCE(agg.n, 0)::text          AS purchase_count
    FROM suppliers s
    LEFT JOIN LATERAL (
      SELECT SUM(p.price) AS purchased, SUM(p.paid_amount) AS paid, count(*) AS n
        FROM supplier_purchases p WHERE p.supplier_id = s.id
    ) agg ON true`;

@Injectable()
export class SuppliersService {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly transactions: TransactionService,
    private readonly ledger: LedgerService,
  ) {}

  // ---- suppliers -----------------------------------------------------

  async list(query: ListSuppliersQuery): Promise<Page<SupplierRow>> {
    const params: unknown[] = [];
    let clause = '';
    if (query.search) {
      params.push(`%${query.search}%`);
      clause = `WHERE (s.name ILIKE $1 OR s.phone ILIKE $1)`;
    }

    const size = PAGE_SIZE.suppliers;
    const page = query.page && query.page > 0 ? query.page : 1;

    const counted = firstRow<{ count: string }>(
      await this.dataSource.query(
        `SELECT count(*)::text AS count FROM suppliers s ${clause}`,
        params,
      ),
    );

    const rows = rowsOf<SupplierRow>(
      await this.dataSource.query(
        `${SELECT_SUPPLIER} ${clause} ORDER BY s.name
          LIMIT ${size} OFFSET ${(page - 1) * size}`,
        params,
      ),
    );

    return toPage(rows, Number(counted?.count ?? '0'), page, size);
  }

  async options(): Promise<Array<{ id: string; name: string }>> {
    return rowsOf(
      await this.dataSource.query(
        `SELECT id::text, name FROM suppliers ORDER BY name`,
      ),
    );
  }

  async findOne(id: string): Promise<SupplierRow> {
    const row = firstRow<SupplierRow>(
      await this.dataSource.query(`${SELECT_SUPPLIER} WHERE s.id = $1`, [id]),
    );
    if (!row) throw new NotFoundException('No such supplier.');
    return row;
  }

  /**
   * FR-05.1 — register a supplier.
   *
   * The check and the insert share a transaction so the gap between "nobody has
   * this number" and "this supplier has it" cannot be entered twice at once;
   * `uq_suppliers_phone` closes what is left of it either way.
   *
   * Phone and email are stored trimmed, because the indexes that keep them
   * unique key on `btrim()` — an untrimmed value would look different from the
   * one it collides with everywhere except the constraint.
   */
  async create(
    dto: CreateSupplierDto,
    actorId: string | null,
  ): Promise<SupplierRow> {
    const id = await this.transactions.run(async (manager) => {
      await assertContactsAreFree(manager, SUPPLIER_CONTACTS, dto);

      const inserted: unknown = await manager.query(
        `INSERT INTO suppliers (name, phone, address, email, created_by_id, updated_by_id)
         VALUES ($1, $2, $3, $4, $5, $5) RETURNING id::text`,
        [
          dto.name,
          dto.phone.trim(),
          dto.address ?? '',
          (dto.email ?? '').trim(),
          actorId,
        ],
      );
      return firstRow<{ id: string }>(inserted)!.id;
    });

    return this.findOne(id);
  }

  async update(
    id: string,
    dto: UpdateSupplierDto,
    actorId: string | null,
  ): Promise<SupplierRow> {
    // Excluding this supplier's own row: re-saving a record without touching
    // its phone must not report the record against itself.
    await assertContactsAreFree(
      this.dataSource.manager,
      SUPPLIER_CONTACTS,
      dto,
      id,
    );

    const sets: string[] = [];
    const params: unknown[] = [];
    const set = (column: string, value: unknown) => {
      params.push(value);
      sets.push(`${column} = $${params.length}`);
    };
    for (const key of ['name', 'phone', 'address', 'email'] as const) {
      if (dto[key] === undefined) continue;
      // As in create(): trimmed, to match the indexes.
      const value = dto[key];
      set(key, key === 'phone' || key === 'email' ? value.trim() : value);
    }
    if (sets.length === 0) return this.findOne(id);

    set('updated_by_id', actorId);
    params.push(id);
    const updated: unknown = await this.dataSource.query(
      `UPDATE suppliers SET ${sets.join(', ')} WHERE id = $${params.length} RETURNING id`,
      params,
    );
    if (affectedRows(updated) === 0) {
      throw new NotFoundException('No such supplier.');
    }
    return this.findOne(id);
  }

  /** Cascades to purchases and their payments — the supplier owns that history. */
  async remove(id: string): Promise<void> {
    const deleted: unknown = await this.dataSource.query(
      `DELETE FROM suppliers WHERE id = $1 RETURNING id`,
      [id],
    );
    if (affectedRows(deleted) === 0) {
      throw new NotFoundException('No such supplier.');
    }
  }

  // ---- purchases -----------------------------------------------------

  async purchases(supplierId: string): Promise<Array<Record<string, unknown>>> {
    await this.findOne(supplierId);
    return rowsOf(
      await this.dataSource.query(
        `SELECT p.id::text, p.product_name, p.price::text, p.paid_amount::text,
                (p.price - p.paid_amount)::text AS due,
                p.purchase_date::text, p.notes
           FROM supplier_purchases p
          WHERE p.supplier_id = $1
          ORDER BY p.purchase_date DESC, p.id DESC`,
        [supplierId],
      ),
    );
  }

  /**
   * FR-05.3, and BR-32 when an initial payment comes with it.
   *
   * Both rows are written in one transaction: "both are saved atomically or not
   * at all". The overpayment guard is the database's — `purchase_not_overpaid`
   * compares `paid_amount` (maintained by the rollup trigger) against `price`,
   * so an initial payment larger than the purchase is refused whatever this
   * code does.
   */
  async createPurchase(
    supplierId: string,
    dto: CreatePurchaseDto,
    actorId: string | null,
  ): Promise<Record<string, unknown>> {
    await this.findOne(supplierId);

    const purchaseId = await this.transactions.run(async (manager) => {
      const inserted: unknown = await manager.query(
        `INSERT INTO supplier_purchases (supplier_id, product_name, price,
                                         purchase_date, notes,
                                         created_by_id, updated_by_id)
         VALUES ($1, $2, $3, $4, $5, $6, $6) RETURNING id::text`,
        [
          supplierId,
          dto.productName,
          dto.price,
          dto.purchaseDate,
          dto.notes ?? '',
          actorId,
        ],
      );
      const id = firstRow<{ id: string }>(inserted)!.id;

      if (dto.initialPayment !== undefined) {
        if (!dto.initialPaymentMethodId) {
          throw new BadRequestException(
            'initialPaymentMethodId is required when an initial payment is given.',
          );
        }
        await this.writePayment(manager, id, {
          amount: dto.initialPayment,
          paymentDate: dto.purchaseDate,
          paymentMethodId: dto.initialPaymentMethodId,
          referenceNumber: dto.initialPaymentReference,
          notes: 'Initial payment',
        });
      }

      return id;
    });

    return this.findPurchase(purchaseId);
  }

  async findPurchase(id: string): Promise<Record<string, unknown>> {
    const row = firstRow<Record<string, unknown>>(
      await this.dataSource.query(
        `SELECT p.id::text, p.supplier_id::text, s.name AS supplier_name,
                p.product_name, p.price::text, p.paid_amount::text,
                (p.price - p.paid_amount)::text AS due,
                p.purchase_date::text, p.notes
           FROM supplier_purchases p JOIN suppliers s ON s.id = p.supplier_id
          WHERE p.id = $1`,
        [id],
      ),
    );
    if (!row) throw new NotFoundException('No such purchase.');
    return row;
  }

  async updatePurchase(
    id: string,
    dto: UpdatePurchaseDto,
    actorId: string | null,
  ): Promise<Record<string, unknown>> {
    const sets: string[] = [];
    const params: unknown[] = [];
    const set = (column: string, value: unknown) => {
      params.push(value);
      sets.push(`${column} = $${params.length}`);
    };
    if (dto.productName !== undefined) set('product_name', dto.productName);
    if (dto.price !== undefined) set('price', dto.price);
    if (dto.purchaseDate !== undefined) set('purchase_date', dto.purchaseDate);
    if (dto.notes !== undefined) set('notes', dto.notes);
    if (sets.length === 0) return this.findPurchase(id);

    set('updated_by_id', actorId);
    params.push(id);

    // Lowering the price below what has already been paid is refused by
    // `purchase_not_overpaid` — a 422 naming the constraint, which is correct:
    // the money has moved and the price is what is wrong.
    const updated: unknown = await this.dataSource.query(
      `UPDATE supplier_purchases SET ${sets.join(', ')}
        WHERE id = $${params.length} RETURNING id`,
      params,
    );
    if (affectedRows(updated) === 0) {
      throw new NotFoundException('No such purchase.');
    }
    return this.findPurchase(id);
  }

  async removePurchase(id: string): Promise<void> {
    await this.transactions.run(async (manager) => {
      // The payments cascade, so their ledger lines must go too (BR-40).
      const receipts = rowsOf<{ receipt_number: string }>(
        await manager.query(
          `SELECT receipt_number FROM supplier_purchase_payments WHERE purchase_id = $1`,
          [id],
        ),
      );
      for (const r of receipts) {
        await this.ledger.remove(manager, 'supplier_payment', r.receipt_number);
      }

      const deleted: unknown = await manager.query(
        `DELETE FROM supplier_purchases WHERE id = $1 RETURNING id`,
        [id],
      );
      if (affectedRows(deleted) === 0) {
        throw new NotFoundException('No such purchase.');
      }
    });
  }

  // ---- payments ------------------------------------------------------

  async payments(purchaseId: string): Promise<Array<Record<string, unknown>>> {
    return rowsOf(
      await this.dataSource.query(
        `SELECT pp.id::text, pp.receipt_number, pp.amount::text,
                pp.payment_date::text, pp.method_code, m.label AS method_label,
                pp.reference_number, pp.notes
           FROM supplier_purchase_payments pp
           JOIN payment_methods m ON m.id = pp.payment_method_id
          WHERE pp.purchase_id = $1
          ORDER BY pp.payment_date DESC, pp.id DESC`,
        [purchaseId],
      ),
    );
  }

  /**
   * A payment against one purchase.
   *
   * The purchase row is locked first: §16 fixes the order as parent then child,
   * and two payments racing past the same remaining-due check is exactly what
   * the lock prevents. `purchase_not_overpaid` is the guarantee behind it
   * (BR-30) — the lock is there so the user gets a sentence rather than a
   * constraint violation.
   */
  async addPayment(
    purchaseId: string,
    dto: CreatePurchasePaymentDto,
    actorId: string | null,
  ): Promise<Record<string, unknown>> {
    await this.transactions.run(async (manager) => {
      const purchase = await lockRow<{ price: string; paid_amount: string }>(
        manager,
        'supplier_purchases',
        purchaseId,
      );
      if (!purchase) throw new NotFoundException('No such purchase.');

      const due = new Decimal(purchase.price).minus(purchase.paid_amount);
      if (new Decimal(dto.amount).greaterThan(due)) {
        throw new BadRequestException(
          `That payment exceeds the ${due.toFixed(2)} still due on this purchase.`,
        );
      }

      await this.writePayment(manager, purchaseId, dto, actorId);
    });

    return this.findPurchase(purchaseId);
  }

  async updatePayment(
    id: string,
    dto: UpdatePurchasePaymentDto,
    actorId: string | null,
  ): Promise<Record<string, unknown>> {
    return this.transactions.run(async (manager) => {
      const payment = firstRow<{
        purchase_id: string;
        receipt_number: string;
        amount: string;
      }>(
        await manager.query(
          `SELECT purchase_id::text, receipt_number, amount::text
             FROM supplier_purchase_payments WHERE id = $1`,
          [id],
        ),
      );
      if (!payment) throw new NotFoundException('No such payment.');

      await lockRow(manager, 'supplier_purchases', payment.purchase_id);

      const sets: string[] = [];
      const params: unknown[] = [];
      const set = (column: string, value: unknown) => {
        params.push(value);
        sets.push(`${column} = $${params.length}`);
      };
      if (dto.amount !== undefined) set('amount', dto.amount);
      if (dto.paymentDate !== undefined) set('payment_date', dto.paymentDate);
      if (dto.referenceNumber !== undefined)
        set('reference_number', dto.referenceNumber);
      if (dto.notes !== undefined) set('notes', dto.notes);

      if (sets.length > 0) {
        set('updated_by_id', actorId);
        params.push(id);
        await manager.query(
          `UPDATE supplier_purchase_payments SET ${sets.join(', ')}
            WHERE id = $${params.length}`,
          params,
        );
      }

      // BR-40 — the ledger follows the payment.
      if (dto.amount !== undefined) {
        await this.ledger.updateAmount(
          manager,
          'supplier_payment',
          payment.receipt_number,
          dto.amount,
        );
      }

      return this.findPurchase(payment.purchase_id);
    });
  }

  async removePayment(id: string): Promise<void> {
    await this.transactions.run(async (manager) => {
      const payment = firstRow<{ purchase_id: string; receipt_number: string }>(
        await manager.query(
          `SELECT purchase_id::text, receipt_number
             FROM supplier_purchase_payments WHERE id = $1`,
          [id],
        ),
      );
      if (!payment) throw new NotFoundException('No such payment.');

      await lockRow(manager, 'supplier_purchases', payment.purchase_id);
      await manager.query(
        `DELETE FROM supplier_purchase_payments WHERE id = $1`,
        [id],
      );
      // BR-40 — deleting a payment removes its ledger entry.
      await this.ledger.remove(
        manager,
        'supplier_payment',
        payment.receipt_number,
      );
    });
  }

  /**
   * BR-31 — paying at the supplier level allocates **oldest purchase first**,
   * by purchase date, and may not exceed the supplier's total outstanding.
   *
   * The supplier row is locked before its purchases (§16: parent, then
   * children), so two simultaneous payments cannot both allocate against the
   * same balance.
   */
  async paySupplier(
    supplierId: string,
    dto: SupplierPaymentDto,
    actorId: string | null,
  ): Promise<{ allocated: Array<{ purchaseId: string; amount: string }> }> {
    return this.transactions.run(async (manager) => {
      const supplier = await lockRow(manager, 'suppliers', supplierId);
      if (!supplier) throw new NotFoundException('No such supplier.');

      const outstanding = rowsOf<{
        id: string;
        price: string;
        paid_amount: string;
      }>(
        await manager.query(
          `SELECT id::text, price::text, paid_amount::text
             FROM supplier_purchases
            WHERE supplier_id = $1 AND paid_amount < price
            ORDER BY purchase_date, id
              FOR UPDATE`,
          [supplierId],
        ),
      );

      const totalDue = outstanding.reduce(
        (sum, p) => sum.plus(new Decimal(p.price).minus(p.paid_amount)),
        new Decimal(0),
      );

      let remaining = new Decimal(dto.amount);
      if (remaining.greaterThan(totalDue)) {
        throw new BadRequestException(
          `That payment exceeds the ${totalDue.toFixed(2)} this supplier is owed.`,
        );
      }

      const allocated: Array<{ purchaseId: string; amount: string }> = [];

      for (const purchase of outstanding) {
        if (remaining.lessThanOrEqualTo(0)) break;

        const due = new Decimal(purchase.price).minus(purchase.paid_amount);
        const applied = Decimal.min(due, remaining);

        await this.writePayment(
          manager,
          purchase.id,
          { ...dto, amount: applied.toFixed(2) },
          actorId,
        );

        allocated.push({ purchaseId: purchase.id, amount: applied.toFixed(2) });
        remaining = remaining.minus(applied);
      }

      return { allocated };
    });
  }

  /**
   * The one place a supplier payment row is written.
   *
   * Two things it must get right, and both are why this is a single helper:
   *
   *  - **The method is written as a pair** (§23.6): `payment_method_id` and
   *    `method_code` come from one lookup, never independently. The composite
   *    foreign key rejects the row if they disagree (BR-64), and BR-29 reads
   *    the code from the row itself.
   *  - **The ledger post happens here** (BR-38), in the same transaction, so a
   *    payment can never exist without its debit.
   */
  private async writePayment(
    manager: EntityManager,
    purchaseId: string,
    dto: {
      amount: string;
      paymentDate: string;
      paymentMethodId: string;
      referenceNumber?: string;
      notes?: string;
    },
    actorId: string | null = null,
  ): Promise<void> {
    const method = firstRow<{ id: string; code: string; label: string }>(
      await manager.query(
        `SELECT id::text, code, label FROM payment_methods
          WHERE id = $1 AND scope = 'supplier'`,
        [dto.paymentMethodId],
      ),
    );
    if (!method) {
      throw new BadRequestException(
        'That is not a supplier payment method. Supplier payments may only use ' +
          'methods scoped to `supplier`.',
      );
    }

    // BR-29 in the application, so the user gets a sentence; the CHECK
    // constraint `supplierpayment_reference_required` is the guarantee.
    if (method.code !== 'cash' && !dto.referenceNumber?.trim()) {
      throw new BadRequestException(
        `A reference number is required for ${method.label} payments. ` +
          'Only cash needs none.',
      );
    }

    const receipt = supplierPaymentNumber();

    await manager.query(
      `INSERT INTO supplier_purchase_payments
         (purchase_id, receipt_number, amount, payment_date,
          payment_method_id, method_code, reference_number, notes,
          created_by_id, updated_by_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $9)`,
      [
        purchaseId,
        receipt,
        dto.amount,
        dto.paymentDate,
        method.id,
        method.code,
        dto.referenceNumber ?? '',
        dto.notes ?? '',
        actorId,
      ],
    );

    // FR-08.1 — a payment made to a supplier posts as a Debit.
    await this.ledger.post(manager, {
      entryType: 'debit',
      source: 'supplier_payment',
      reference: receipt,
      amount: dto.amount,
      description: `Supplier payment ${receipt}`,
    });
  }
}
