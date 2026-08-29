import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { Decimal } from '../../common/decimal';
import { customerPaymentBatchRef } from '../../common/identifiers';
import { firstRow, rowsOf } from '../../common/sql';
import { lockRow, TransactionService } from '../../common/transaction';
import { SalePaymentsService } from './sale-payments.service';
import type { CustomerPaymentDto } from './dto';

/**
 * FR-03.5 — a single lump sum from a customer, distributed by the system rather
 * than settling invoices one at a time.
 *
 * **Why the batch does not replace the per-sale payments.** A batch could have
 * been one payment row linked to many sales. It is not, because BR-18 requires
 * every sale's own payment history to stay complete and independently
 * printable — so the allocator creates a *real* `sale_payments` row per sale it
 * touches, indistinguishable from one entered directly, and the batch and
 * allocation rows sit above them as a record of the grouping (BR-19).
 */
@Injectable()
export class CustomerPaymentsService {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly transactions: TransactionService,
    private readonly payments: SalePaymentsService,
  ) {}

  /**
   * FR-03.4 — the customer account: every finalised order with totals, and the
   * history of payment events showing how many invoices each was spread across.
   */
  async account(customerId: string): Promise<Record<string, unknown>> {
    const customer = firstRow<Record<string, unknown>>(
      await this.dataSource.query(
        `SELECT c.id::text, c.customer_id, c.name, c.company, c.phone,
                sh.name AS shop_name
           FROM customers c JOIN shops sh ON sh.id = c.shop_id
          WHERE c.id = $1`,
        [customerId],
      ),
    );
    if (!customer) throw new NotFoundException('No such customer.');

    // BR-03 — drafts and quotations are excluded from every total.
    const totals = firstRow<Record<string, string>>(
      await this.dataSource.query(
        `SELECT COALESCE(SUM(total_amount), 0)::text  AS invoiced,
                COALESCE(SUM(amount_paid), 0)::text   AS received,
                COALESCE(SUM(total_amount - amount_paid), 0)::text AS due,
                count(*)::text                        AS order_count
           FROM sales WHERE customer_id = $1 AND status_code = 'finalized'`,
        [customerId],
      ),
    )!;

    const orders = rowsOf(
      await this.dataSource.query(
        `SELECT id::text, sale_number, finalized_at, total_amount::text,
                amount_paid::text, (total_amount - amount_paid)::text AS balance_due
           FROM sales
          WHERE customer_id = $1 AND status_code = 'finalized'
          ORDER BY finalized_at DESC`,
        [customerId],
      ),
    );

    const paymentEvents = rowsOf(
      await this.dataSource.query(
        `SELECT b.id::text, b.batch_ref, b.payment_date::text, b.total_amount::text,
                m.label AS method_label, b.notes,
                count(a.id)::text AS invoices_settled
           FROM customer_payment_batches b
           JOIN payment_methods m ON m.id = b.payment_method_id
           LEFT JOIN customer_payment_allocations a ON a.batch_id = b.id
          WHERE b.customer_id = $1
          GROUP BY b.id, m.label
          ORDER BY b.created_at DESC`,
        [customerId],
      ),
    );

    return { customer, totals, orders, paymentEvents };
  }

  /** FR-03.5.1 — the action is offered only when the customer owes something. */
  async outstanding(customerId: string): Promise<string> {
    const row = firstRow<{ due: string }>(
      await this.dataSource.query(
        `SELECT COALESCE(SUM(total_amount - amount_paid), 0)::text AS due
           FROM sales WHERE customer_id = $1 AND status_code = 'finalized'`,
        [customerId],
      ),
    );
    return row?.due ?? '0';
  }

  /**
   * Take one amount and spread it across the customer's open invoices.
   *
   * **BR-16** — oldest finalised sale first, ordered by finalisation time.
   * **BR-17** — it may not exceed the customer's total outstanding; if it would,
   * the whole event is rejected and nothing is written.
   * **BR-20** — allocation is serialised per customer: the customer row is
   * locked first, then the candidate sales, which is §16's order and the same
   * one the single-payment path uses.
   */
  async allocate(
    customerId: string,
    dto: CustomerPaymentDto,
    actorId: string | null,
  ): Promise<Record<string, unknown>> {
    return this.transactions.run(async (manager) => {
      const customer = await lockRow(manager, 'customers', customerId);
      if (!customer) throw new NotFoundException('No such customer.');

      /**
       * BR-16's ordering, and the index `idx_sale_fifo` exists precisely for
       * this query: `(customer_id, finalized_at, id) WHERE status_code =
       * 'finalized'`. Without it this is a sequential scan *while holding row
       * locks*, which turns a slow query into a lock-contention incident.
       */
      const open = rowsOf<{
        id: string;
        sale_number: string;
        total_amount: string;
        amount_paid: string;
      }>(
        await manager.query(
          `SELECT id::text, sale_number, total_amount::text, amount_paid::text
             FROM sales
            WHERE customer_id = $1
              AND status_code = 'finalized'
              AND amount_paid < total_amount
            ORDER BY finalized_at, id
              FOR UPDATE`,
          [customerId],
        ),
      );

      const totalDue = open.reduce(
        (sum, s) => sum.plus(new Decimal(s.total_amount).minus(s.amount_paid)),
        new Decimal(0),
      );

      const amount = new Decimal(dto.amount);
      if (amount.lessThanOrEqualTo(0)) {
        throw new BadRequestException('A payment must be for more than zero.');
      }
      if (amount.greaterThan(totalDue)) {
        throw new BadRequestException(
          `That payment exceeds the ${totalDue.toFixed(2)} this customer ` +
            `owes. Nothing has been written.`,
        );
      }

      const method = firstRow<{ id: string }>(
        await manager.query(
          `SELECT id::text FROM payment_methods WHERE id = $1 AND scope = 'customer'`,
          [dto.paymentMethodId],
        ),
      );
      if (!method) {
        throw new BadRequestException('That is not a customer payment method.');
      }

      // BR-19 — the whole event is grouped under one reference.
      const batchRef = customerPaymentBatchRef();
      const batch = firstRow<{ id: string }>(
        await manager.query(
          `INSERT INTO customer_payment_batches
             (customer_id, batch_ref, payment_date, payment_method_id,
              total_amount, notes, created_by_id, updated_by_id)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $7) RETURNING id::text`,
          [
            customerId,
            batchRef,
            dto.paymentDate,
            method.id,
            dto.amount,
            dto.notes ?? '',
            actorId,
          ],
        ),
      )!;

      let remaining = amount;
      const allocations: Array<Record<string, string>> = [];

      for (const sale of open) {
        if (remaining.lessThanOrEqualTo(0)) break;

        const due = new Decimal(sale.total_amount).minus(sale.amount_paid);
        const applied = Decimal.min(due, remaining);

        /**
         * BR-18 — each sale touched gets its own payment record and its own
         * receipt number, so per-invoice histories stay accurate and
         * independently printable. BR-19 requires the batch and the payments it
         * generates to record the same method, which is why the same
         * `paymentMethodId` is passed through.
         */
        const receipt = await this.payments.write(
          manager,
          sale.id,
          {
            amount: applied.toFixed(2),
            paymentDate: dto.paymentDate,
            paymentMethodId: dto.paymentMethodId,
            notes: `Allocated from ${batchRef}`,
          },
          actorId,
        );

        const payment = firstRow<{ id: string }>(
          await manager.query(
            `SELECT id::text FROM sale_payments WHERE receipt_number = $1`,
            [receipt],
          ),
        )!;

        await manager.query(
          `INSERT INTO customer_payment_allocations
             (batch_id, sale_id, sale_payment_id, amount, created_by_id, updated_by_id)
           VALUES ($1, $2, $3, $4, $5, $5)`,
          [batch.id, sale.id, payment.id, applied.toFixed(2), actorId],
        );

        allocations.push({
          saleId: sale.id,
          saleNumber: sale.sale_number,
          receiptNumber: receipt,
          amount: applied.toFixed(2),
        });

        remaining = remaining.minus(applied);
      }

      return {
        batchRef,
        totalAmount: amount.toFixed(2),
        invoicesSettled: allocations.length,
        allocations,
      };
    });
  }

  /** BR-19 — the combined receipt, reconstructed from the allocations. */
  async batch(batchRef: string): Promise<Record<string, unknown>> {
    const batch = firstRow<Record<string, unknown>>(
      await this.dataSource.query(
        `SELECT b.id::text, b.batch_ref, b.payment_date::text, b.total_amount::text,
                b.notes, m.label AS method_label,
                c.name AS customer_name, c.customer_id AS customer_number,
                u.username AS recorded_by
           FROM customer_payment_batches b
           JOIN payment_methods m ON m.id = b.payment_method_id
           JOIN customers c ON c.id = b.customer_id
           LEFT JOIN users u ON u.id = b.created_by_id
          WHERE b.batch_ref = $1`,
        [batchRef],
      ),
    );
    if (!batch) throw new NotFoundException('No such payment reference.');

    const allocations = rowsOf(
      await this.dataSource.query(
        `SELECT a.amount::text, s.sale_number, p.receipt_number
           FROM customer_payment_allocations a
           JOIN sales s ON s.id = a.sale_id
           JOIN sale_payments p ON p.id = a.sale_payment_id
          WHERE a.batch_id = (SELECT id FROM customer_payment_batches WHERE batch_ref = $1)
          ORDER BY s.finalized_at`,
        [batchRef],
      ),
    );

    return { ...batch, allocations };
  }
}
