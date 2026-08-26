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
 *  - **BR-11** no payment against a cancelled sale, nor against a quotation.
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
                m.code AS method_code, m.label AS method_label, p.notes,
                a.batch_id::text
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
          `That payment exceeds the ${due.toFixed(2)} still due on this sale (BR-09).`,
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
      throw new BadRequestException(
        'A payment must be for more than zero (BR-10).',
      );
    }

    const method = firstRow<{ id: string; label: string }>(
      await manager.query(
        `SELECT id::text, label FROM payment_methods
          WHERE id = $1 AND scope = 'customer'`,
        [dto.paymentMethodId],
      ),
    );
    if (!method) {
      throw new BadRequestException(
        'That is not a customer payment method. A sale receipt may only use ' +
          'methods scoped to `customer` (BR-62).',
      );
    }

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
            'A payment must be for more than zero (BR-10).',
          );
        }
        set('amount', dto.amount);
      }
      if (dto.paymentDate !== undefined) set('payment_date', dto.paymentDate);
      if (dto.notes !== undefined) set('notes', dto.notes);
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
      await manager.query(`DELETE FROM sale_payments WHERE id = $1`, [id]);
      await this.ledger.remove(manager, 'sale_payment', payment.receipt_number);
    });
  }

  /** BR-11 — cancelled sales and quotations cannot take payment. */
  private assertPayable(statusCode: string): void {
    if (statusCode === 'cancelled') {
      throw new BadRequestException(
        'A cancelled sale cannot take a payment (BR-11).',
      );
    }
    if (statusCode === 'quote') {
      throw new BadRequestException(
        'A quotation cannot take a payment (BR-11). Convert it to an invoice first.',
      );
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
