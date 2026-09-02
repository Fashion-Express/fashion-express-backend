import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, EntityManager } from 'typeorm';
import { Decimal } from '../../common/decimal';
import { saleReceiptNumber } from '../../common/identifiers';
import { firstRow, rowsOf } from '../../common/sql';
import { lockRow, TransactionService } from '../../common/transaction';
import { LedgerService } from '../ledger/ledger.service';
import type { CreateSalePaymentDto, UpdateSalePaymentDto } from './dto';

/**
 * FR-02.5 — payments against one sale.
 *
 * Three rules govern them, and the database backs all three:
 *
 *  - **BR-09** the total of all payments must never exceed the sale's value.
 *    `sale_not_overpaid` is a real constraint over `amount_paid`, which the
 *    rollup trigger keeps true, so it holds even against a bulk write.
 *  - **BR-10** no payment of zero or less. A zero payment produces a receipt
 *    number and a ledger line for no money — noise in an audit trail.
 *  - **BR-11** no payment against a cancelled sale. A quotation or a draft
 *    may take one — it is an advance, and it counts toward no money figure
 *    until the sale is finalised.
 *
 * Every payment posts a **Credit** to the ledger in the same transaction
 * (FR-08.1, BR-38), and edits and deletes carry the ledger with them (BR-40).
 */
@Injectable()
export class SalePaymentsService {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly transactions: TransactionService,
    private readonly ledger: LedgerService,
  ) {}

  async forSale(saleId: string): Promise<Array<Record<string, unknown>>> {
    return rowsOf(
      await this.dataSource.query(
        `SELECT p.id::text, p.receipt_number, p.amount::text, p.payment_date::text,
                p.payment_method_id::text,
                m.code AS method_code, m.label AS method_label, p.notes,
                p.created_at, a.batch_id::text
           FROM sale_payments p
           JOIN payment_methods m ON m.id = p.payment_method_id
           LEFT JOIN customer_payment_allocations a ON a.sale_payment_id = p.id
          WHERE p.sale_id = $1
          ORDER BY p.payment_date DESC, p.id DESC`,
        [saleId],
      ),
    );
  }

  /**
   * Add a payment to a sale.
   *
   * The lock order is §16's: the sale row first, then the customer. The
   * customer allocator takes them in the same order, which is what stops the
   * two paths deadlocking against each other.
   */
  async add(
    saleId: string,
    dto: CreateSalePaymentDto,
    actorId: string | null,
  ): Promise<Record<string, unknown>> {
    return this.transactions.run(async (manager) => {
      const sale = await lockRow<{
        id: string;
        customer_id: string;
        status_code: string;
        total_amount: string;
        amount_paid: string;
      }>(manager, 'sales', saleId);
      if (!sale) throw new NotFoundException('No such sale.');

      this.assertPayable(sale.status_code);
      await lockRow(manager, 'customers', sale.customer_id);

      const due = new Decimal(sale.total_amount).minus(sale.amount_paid);
      if (new Decimal(dto.amount).greaterThan(due)) {
        throw new BadRequestException(
          `That payment exceeds the ${due.toFixed(2)} still due on this sale.`,
        );
      }

      const receipt = await this.write(manager, saleId, dto, actorId);
      return { receiptNumber: receipt };
    });
  }

  /**
   * The one place a sale payment row is written — used by the direct path
   * above, by the initial payment on a new sale, and by the customer allocator
   * (BR-18 requires each sale it touches to get a real payment row of its own).
   */
  async write(
    manager: EntityManager,
    saleId: string,
    dto: {
      amount: string;
      paymentDate: string;
      paymentMethodId: string;
      notes?: string;
    },
    actorId: string | null,
  ): Promise<string> {
    if (new Decimal(dto.amount).lessThanOrEqualTo(0)) {
      throw new BadRequestException('A payment must be for more than zero.');
    }

    const method = await this.customerMethod(manager, dto.paymentMethodId);

    const receipt = saleReceiptNumber();

    await manager.query(
      `INSERT INTO sale_payments (sale_id, receipt_number, amount, payment_date,
                                  payment_method_id, notes, created_by_id, updated_by_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $7)`,
      [
        saleId,
        receipt,
        dto.amount,
        dto.paymentDate,
        method.id,
        dto.notes ?? '',
        actorId,
      ],
    );

    // FR-08.1 — a payment received against a sale posts as a Credit.
    await this.ledger.post(manager, {
      entryType: 'credit',
      source: 'sale_payment',
      reference: receipt,
      amount: dto.amount,
      description: `Sale payment ${receipt}`,
    });

    return receipt;
  }

  async update(
    id: string,
    dto: UpdateSalePaymentDto,
    actorId: string | null,
  ): Promise<void> {
    await this.transactions.run(async (manager) => {
      const payment = firstRow<{
        sale_id: string;
        receipt_number: string;
      }>(
        await manager.query(
          `SELECT sale_id::text, receipt_number FROM sale_payments WHERE id = $1`,
          [id],
        ),
      );
      if (!payment) throw new NotFoundException('No such payment.');

      await lockRow(manager, 'sales', payment.sale_id);

      const sets: string[] = [];
      const params: unknown[] = [];
      const set = (column: string, value: unknown) => {
        params.push(value);
        sets.push(`${column} = $${params.length}`);
      };
      if (dto.amount !== undefined) {
        if (new Decimal(dto.amount).lessThanOrEqualTo(0)) {
          throw new BadRequestException(
            'A payment must be for more than zero.',
          );
        }
        set('amount', dto.amount);
      }
      if (dto.paymentDate !== undefined) set('payment_date', dto.paymentDate);
      if (dto.notes !== undefined) set('notes', dto.notes);
      if (dto.paymentMethodId !== undefined) {
        // BR-62 is re-checked here, not just on insert: the scope pinning is a
        // foreign key over (method, scope), so an unchecked update would fail
        // as a constraint violation instead of a sentence.
        const method = await this.customerMethod(manager, dto.paymentMethodId);
        set('payment_method_id', method.id);
      }
      if (sets.length === 0) return;

      set('updated_by_id', actorId);
      params.push(id);

      // BR-09 holds on edit as well as on insert: raising an amount past the
      // sale total trips `sale_not_overpaid` through the rollup trigger.
      await manager.query(
        `UPDATE sale_payments SET ${sets.join(', ')} WHERE id = $${params.length}`,
        params,
      );

      if (dto.amount !== undefined) {
        await this.ledger.updateAmount(
          manager,
          'sale_payment',
          payment.receipt_number,
          dto.amount,
        );

        /*
         * A repriced payment that came from a lump sum moves its allocation
         * with it, and the batch total follows. Without this the combined
         * receipt keeps quoting the amount originally taken while the invoices
         * under it say something else.
         */
        const allocation = await this.allocationOf(manager, id);
        if (allocation) {
          await lockRow(manager, 'customers', allocation.customer_id);
          await manager.query(
            `UPDATE customer_payment_allocations SET amount = $1
              WHERE sale_payment_id = $2`,
            [dto.amount, id],
          );
          await this.resyncBatch(manager, allocation.batch_id);
        }
      }
    });
  }

  async remove(id: string): Promise<void> {
    await this.transactions.run(async (manager) => {
      const payment = firstRow<{ sale_id: string; receipt_number: string }>(
        await manager.query(
          `SELECT sale_id::text, receipt_number FROM sale_payments WHERE id = $1`,
          [id],
        ),
      );
      if (!payment) throw new NotFoundException('No such payment.');

      await lockRow(manager, 'sales', payment.sale_id);

      /*
       * Read the grouping BEFORE the delete: `customer_payment_allocations`
       * cascades off `sale_payments`, so once the row is gone there is nothing
       * left to say which batch it belonged to.
       *
       * Locks follow `add()` above — the sale row, then the customer — so the
       * two write paths in this file take them in the same order.
       */
      const allocation = await this.allocationOf(manager, id);
      if (allocation) {
        await lockRow(manager, 'customers', allocation.customer_id);
      }

      await manager.query(`DELETE FROM sale_payments WHERE id = $1`, [id]);
      await this.ledger.remove(manager, 'sale_payment', payment.receipt_number);

      // The allocation went with the payment; the batch above it has to be
      // told (BR-19).
      if (allocation) await this.resyncBatch(manager, allocation.batch_id);
    });
  }

  /**
   * BR-62 — a sale receipt may only carry a `customer`-scoped method. The
   * column pair `(payment_method_id, payment_scope)` is a real foreign key, so
   * the database refuses a supplier method anyway; this turns that refusal into
   * a sentence naming what went wrong. Shared by insert and edit so the two
   * cannot drift apart.
   */
  private async customerMethod(
    manager: EntityManager,
    paymentMethodId: string,
  ): Promise<{ id: string; label: string }> {
    const method = firstRow<{ id: string; label: string }>(
      await manager.query(
        `SELECT id::text, label FROM payment_methods
          WHERE id = $1 AND scope = 'customer'`,
        [paymentMethodId],
      ),
    );
    if (!method) {
      throw new BadRequestException(
        'That is not a customer payment method. A sale receipt may only use ' +
          'methods scoped to `customer`.',
      );
    }
    return method;
  }

  /**
   * The allocation a payment belongs to, if it came from a customer lump sum.
   *
   * A payment created by the allocator is a real `sale_payments` row like any
   * other (BR-18), so an edit or a delete reaches it through the same paths as
   * a directly-entered one — and has to carry BR-19's grouping with it.
   */
  private async allocationOf(
    manager: EntityManager,
    paymentId: string,
  ): Promise<{ batch_id: string; customer_id: string } | undefined> {
    return firstRow<{ batch_id: string; customer_id: string }>(
      await manager.query(
        `SELECT a.batch_id::text, b.customer_id::text
           FROM customer_payment_allocations a
           JOIN customer_payment_batches b ON b.id = a.batch_id
          WHERE a.sale_payment_id = $1`,
        [paymentId],
      ),
    );
  }

  /**
   * BR-19 — put the batch back in step with the payments it actually covers.
   *
   * The combined receipt is the sum of its allocations, so once one of them has
   * moved or gone the stored `total_amount` is a claim about money that is no
   * longer there. Recomputed from the allocations rather than adjusted by a
   * delta: a delta is only right if nothing else changed in between, and the
   * sum is right unconditionally.
   *
   * An emptied batch is DELETED, not zeroed — `batch_amount_positive` forbids a
   * zero total, and a receipt covering no invoices is not a record of anything.
   */
  private async resyncBatch(
    manager: EntityManager,
    batchId: string,
  ): Promise<void> {
    const total = firstRow<{ total: string | null; lines: string }>(
      await manager.query(
        `SELECT SUM(amount)::text AS total, count(*)::text AS lines
           FROM customer_payment_allocations WHERE batch_id = $1`,
        [batchId],
      ),
    );

    if (!total || Number(total.lines) === 0) {
      await manager.query(
        `DELETE FROM customer_payment_batches WHERE id = $1`,
        [batchId],
      );
      return;
    }

    await manager.query(
      `UPDATE customer_payment_batches SET total_amount = $1 WHERE id = $2`,
      [total.total, batchId],
    );
  }

  /**
   * BR-11 — a cancelled sale cannot take payment. Every other status can,
   * quotations included: an advance against an offer is ordinary trade, and
   * the money is held against the sale until it is finalised, at which point
   * it starts counting toward revenue like any other payment.
   */
  private assertPayable(statusCode: string): void {
    if (statusCode === 'cancelled') {
      throw new BadRequestException('A cancelled sale cannot take a payment.');
    }
  }

  /** Used by FR-02.6.2 when an emptied sale reverts to draft. */
  async removeAllForSale(
    manager: EntityManager,
    saleId: string,
  ): Promise<number> {
    const receipts = rowsOf<{ receipt_number: string }>(
      await manager.query(
        `SELECT receipt_number FROM sale_payments WHERE sale_id = $1`,
        [saleId],
      ),
    );
    for (const r of receipts) {
      await this.ledger.remove(manager, 'sale_payment', r.receipt_number);
    }
    await manager.query(`DELETE FROM sale_payments WHERE sale_id = $1`, [
      saleId,
    ]);
    return receipts.length;
  }
}
