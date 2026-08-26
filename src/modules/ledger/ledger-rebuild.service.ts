import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { rowsOf } from '../../common/sql';
import { TransactionService } from '../../common/transaction';
import { expenseLedgerRef } from '../expenses/expenses.service';
import { LedgerService } from './ledger.service';

export interface RebuildReport {
  preview: boolean;
  posted: { salePayments: number; expenses: number; supplierPayments: number };
  alreadyPresent: number;
  orphaned: Array<{ source: string; reference: string; amount: string }>;
}

/**
 * FR-08.3 — the ledger can be rebuilt from existing records, with a preview
 * mode that reports what it would post before writing anything.
 *
 * This exists because the ledger is a derived record: every line restates
 * something that already happened in `sale_payments`, `expenses` or
 * `supplier_purchase_payments`. If a post were ever missed — a bug, a restore
 * from a partial backup, a migration — the source records are still the truth
 * and the ledger can be brought back into line with them.
 *
 * It is safe to run repeatedly. Every post goes through `LedgerService.post`,
 * which is `INSERT … ON CONFLICT DO NOTHING` over the `(source_id, reference)`
 * unique index (BR-39), so an entry that already exists is simply not written
 * again. That is what makes "rebuild" a reconciliation rather than a
 * duplication.
 */
@Injectable()
export class LedgerRebuildService {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly transactions: TransactionService,
    private readonly ledger: LedgerService,
  ) {}

  async rebuild(preview: boolean): Promise<RebuildReport> {
    const salePayments = rowsOf<{
      receipt_number: string;
      amount: string;
      sale_number: string;
      created_at: string;
    }>(
      await this.dataSource.query(
        `SELECT p.receipt_number, p.amount::text, s.sale_number, p.created_at
           FROM sale_payments p JOIN sales s ON s.id = p.sale_id
          ORDER BY p.id`,
      ),
    );
    const expenses = rowsOf<{
      id: string;
      amount: string;
      description: string;
      created_at: string;
    }>(
      await this.dataSource.query(
        `SELECT id::text, amount::text, description, created_at FROM expenses ORDER BY id`,
      ),
    );
    const supplierPayments = rowsOf<{
      receipt_number: string;
      amount: string;
      created_at: string;
    }>(
      await this.dataSource.query(
        `SELECT receipt_number, amount::text, created_at
           FROM supplier_purchase_payments ORDER BY id`,
      ),
    );

    const report: RebuildReport = {
      preview,
      posted: { salePayments: 0, expenses: 0, supplierPayments: 0 },
      alreadyPresent: 0,
      orphaned: await this.orphaned(),
    };

    /**
     * Preview counts what is *missing* without writing. It asks the same
     * question the insert would — is there a row for this (source, reference)? —
     * so the numbers it reports are the numbers a real run would post.
     */
    if (preview) {
      report.posted.salePayments = await this.countMissing(
        'sale_payment',
        salePayments.map((p) => p.receipt_number),
      );
      report.posted.expenses = await this.countMissing(
        'expense',
        expenses.map((e) => expenseLedgerRef(e.id)),
      );
      report.posted.supplierPayments = await this.countMissing(
        'supplier_payment',
        supplierPayments.map((p) => p.receipt_number),
      );
      const total =
        salePayments.length + expenses.length + supplierPayments.length;
      report.alreadyPresent =
        total -
        report.posted.salePayments -
        report.posted.expenses -
        report.posted.supplierPayments;
      return report;
    }

    await this.transactions.run(async (manager) => {
      for (const payment of salePayments) {
        const written = await this.ledger.post(manager, {
          entryType: 'credit',
          source: 'sale_payment',
          reference: payment.receipt_number,
          amount: payment.amount,
          description: `Sale payment ${payment.receipt_number}`,
          timestamp: new Date(payment.created_at),
        });
        if (written) report.posted.salePayments++;
        else report.alreadyPresent++;
      }

      for (const expense of expenses) {
        const written = await this.ledger.post(manager, {
          entryType: 'debit',
          source: 'expense',
          reference: expenseLedgerRef(expense.id),
          amount: expense.amount,
          description: expense.description.slice(0, 200),
          timestamp: new Date(expense.created_at),
        });
        if (written) report.posted.expenses++;
        else report.alreadyPresent++;
      }

      for (const payment of supplierPayments) {
        const written = await this.ledger.post(manager, {
          entryType: 'debit',
          source: 'supplier_payment',
          reference: payment.receipt_number,
          amount: payment.amount,
          description: `Supplier payment ${payment.receipt_number}`,
          timestamp: new Date(payment.created_at),
        });
        if (written) report.posted.supplierPayments++;
        else report.alreadyPresent++;
      }
    });

    return report;
  }

  private async countMissing(
    sourceCode: string,
    references: string[],
  ): Promise<number> {
    if (references.length === 0) return 0;
    const rows = rowsOf<{ n: string }>(
      await this.dataSource.query(
        `SELECT count(*)::text AS n
           FROM unnest($1::text[]) AS r(reference)
          WHERE NOT EXISTS (
            SELECT 1 FROM ledger_entries e
              JOIN ledger_sources s ON s.id = e.source_id
             WHERE s.code = $2 AND e.reference = r.reference)`,
        [references, sourceCode],
      ),
    );
    return Number(rows[0].n);
  }

  /**
   * Ledger lines whose underlying record no longer exists.
   *
   * The ledger links to its records by a **text reference**, not a foreign key
   * (DB_DESIGN.MD §10), so nothing guarantees the referenced receipt still
   * exists — deleting a payment is supposed to remove its entry (BR-40), but
   * nothing at the database level enforces that. A rebuild cannot fix these
   * (it only adds), so they are reported rather than silently ignored: an
   * orphan means money in the balance that is not in the records.
   */
  private async orphaned(): Promise<
    Array<{ source: string; reference: string; amount: string }>
  > {
    return rowsOf(
      await this.dataSource.query(
        `SELECT s.code AS source, e.reference, e.amount::text
           FROM ledger_entries e
           JOIN ledger_sources s ON s.id = e.source_id
          WHERE e.reference <> ''
            AND CASE s.code
              WHEN 'sale_payment' THEN NOT EXISTS (
                SELECT 1 FROM sale_payments p WHERE p.receipt_number = e.reference)
              WHEN 'supplier_payment' THEN NOT EXISTS (
                SELECT 1 FROM supplier_purchase_payments p
                 WHERE p.receipt_number = e.reference)
              WHEN 'expense' THEN NOT EXISTS (
                SELECT 1 FROM expenses x
                 WHERE 'EXP-' || x.id::text = e.reference)
              ELSE false
            END
          ORDER BY e.id`,
      ),
    );
  }
}
