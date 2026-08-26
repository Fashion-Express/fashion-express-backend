import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, EntityManager } from 'typeorm';
import { PAGE_SIZE, type Page, toPage } from '../../common/pagination';
import { affectedRows, firstRow, rowsOf } from '../../common/sql';
import { TransactionService } from '../../common/transaction';
import { LedgerService } from '../ledger/ledger.service';
import type {
  CreateExpenseDto,
  ListExpensesQuery,
  UpdateExpenseDto,
} from './dto';

export interface ExpenseRow {
  id: string;
  date: string;
  description: string;
  amount: string;
  paid_to: string;
  receipt_number: string;
  notes: string;
  category_code: string;
  category_label: string;
  method_label: string | null;
  shop_id: string | null;
  shop_name: string | null;
  claim_id: string | null;
}

const SELECT_EXPENSE = `
  SELECT e.id::text, e.date::text, e.description, e.amount::text,
         e.paid_to, e.receipt_number, e.notes,
         ec.code AS category_code, ec.label AS category_label,
         e.expense_category_id::text,
         m.label AS method_label, e.payment_method_id::text,
         e.shop_id::text, sh.name AS shop_name,
         bc.id::text AS claim_id
    FROM expenses e
    JOIN expense_categories ec ON ec.id = e.expense_category_id
    LEFT JOIN payment_methods m ON m.id = e.payment_method_id
    LEFT JOIN shops sh ON sh.id = e.shop_id
    LEFT JOIN bill_claims bc ON bc.expense_id = e.id`;

/**
 * The ledger reference for an expense.
 *
 * FR-08.1 calls it "the expense reference", but `receipt_number` is optional
 * and often blank — and BR-39's unique index only protects rows whose reference
 * is non-empty. Keying on the expense's own id instead makes every post
 * unique, makes the rebuild idempotent, and cannot collide with a receipt
 * number someone types.
 */
export const expenseLedgerRef = (id: string): string => `EXP-${id}`;

@Injectable()
export class ExpensesService {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly transactions: TransactionService,
    private readonly ledger: LedgerService,
  ) {}

  private buildWhere(query: ListExpensesQuery): {
    clause: string;
    params: unknown[];
  } {
    const where: string[] = [];
    const params: unknown[] = [];

    if (query.search) {
      params.push(`%${query.search}%`);
      const n = params.length;
      where.push(
        `(e.description ILIKE $${n} OR e.paid_to ILIKE $${n} OR e.receipt_number ILIKE $${n})`,
      );
    }
    if (query.expenseCategoryId) {
      params.push(query.expenseCategoryId);
      where.push(`e.expense_category_id = $${params.length}`);
    }
    if (query.shopId) {
      params.push(query.shopId);
      where.push(`e.shop_id = $${params.length}`);
    }

    /**
     * FR-06.4's precedence, in order: an explicit range wins over a single
     * date, which wins over a month. Stating it here once means the list and
     * the filtered total can never disagree about which filter applied.
     */
    if (query.from || query.to) {
      if (query.from) {
        params.push(query.from);
        where.push(`e.date >= $${params.length}`);
      }
      if (query.to) {
        params.push(query.to);
        where.push(`e.date <= $${params.length}`);
      }
    } else if (query.date) {
      params.push(query.date);
      where.push(`e.date = $${params.length}`);
    } else if (query.month) {
      params.push(`${query.month}-01`);
      where.push(
        `e.date >= $${params.length}::date AND e.date < ($${params.length}::date + interval '1 month')`,
      );
    }

    return {
      clause: where.length ? `WHERE ${where.join(' AND ')}` : '',
      params,
    };
  }

  /**
   * FR-06.5 — the filtered total and the current ledger balance sit above the
   * list. The balance is business-wide and deliberately not filtered: it is the
   * ledger's, not this page's.
   */
  async list(
    query: ListExpensesQuery,
  ): Promise<
    Page<ExpenseRow> & { filteredTotal: string; ledgerBalance: string }
  > {
    const { clause, params } = this.buildWhere(query);
    const size = PAGE_SIZE.expenses;
    const page = query.page && query.page > 0 ? query.page : 1;

    const summary = firstRow<{ count: string; total: string }>(
      await this.dataSource.query(
        `SELECT count(*)::text AS count,
                COALESCE(SUM(e.amount), 0)::text AS total
           FROM expenses e ${clause}`,
        params,
      ),
    )!;

    const rows = rowsOf<ExpenseRow>(
      await this.dataSource.query(
        `${SELECT_EXPENSE} ${clause} ORDER BY e.date DESC, e.created_at DESC
          LIMIT ${size} OFFSET ${(page - 1) * size}`,
        params,
      ),
    );

    return {
      ...toPage(rows, Number(summary.count), page, size),
      filteredTotal: summary.total,
      ledgerBalance: await this.ledger.balance(),
    };
  }

  /** FR-09.1 — expenses by category, ranked by size. */
  async byCategory(year?: string): Promise<Array<Record<string, string>>> {
    const params: unknown[] = [];
    let clause = '';
    if (year) {
      params.push(`${year}-01-01`);
      clause = `WHERE e.date >= $1::date AND e.date < ($1::date + interval '1 year')`;
    }
    return rowsOf(
      await this.dataSource.query(
        `SELECT ec.code, ec.label,
                COALESCE(SUM(e.amount), 0)::text AS total,
                count(e.id)::text AS count
           FROM expense_categories ec
           LEFT JOIN expenses e ON e.expense_category_id = ec.id ${clause}
          GROUP BY ec.id, ec.code, ec.label
          HAVING COALESCE(SUM(e.amount), 0) > 0
          ORDER BY SUM(e.amount) DESC`,
        params,
      ),
    );
  }

  async findOne(id: string): Promise<Record<string, unknown>> {
    const row = firstRow<ExpenseRow>(
      await this.dataSource.query(`${SELECT_EXPENSE} WHERE e.id = $1`, [id]),
    );
    if (!row) throw new NotFoundException('No such expense.');

    /**
     * FR-06.6 — where an expense originated from an approved staff claim, its
     * detail page shows the original claim, who submitted it and who approved
     * it. That provenance is the whole point of linking the two (BR-36).
     */
    const claim = firstRow<Record<string, unknown>>(
      await this.dataSource.query(
        `SELECT bc.id::text, bc.amount::text, bc.description, bc.bill_date::text,
                bc.approval_date::text,
                submitter.username AS submitted_by,
                approver.username  AS approved_by
           FROM bill_claims bc
           LEFT JOIN users submitter ON submitter.id = bc.user_id
           LEFT JOIN users approver  ON approver.id = bc.approved_by_id
          WHERE bc.expense_id = $1`,
        [id],
      ),
    );

    return { ...row, claim: claim ?? null };
  }

  /**
   * BR-33 — anyone holding the add permission may create an expense.
   *
   * Every expense posts a **Debit** to the ledger in the same transaction
   * (FR-08.1, BR-38): money has left the business.
   */
  async create(
    dto: CreateExpenseDto,
    actorId: string | null,
  ): Promise<Record<string, unknown>> {
    const id = await this.transactions.run(async (manager) =>
      this.write(manager, dto, actorId),
    );
    return this.findOne(id);
  }

  /** Shared with claim approval, which creates an expense as part of BR-36. */
  async write(
    manager: EntityManager,
    dto: CreateExpenseDto,
    actorId: string | null,
  ): Promise<string> {
    if (dto.paymentMethodId) {
      const method = firstRow(
        await manager.query(
          `SELECT id FROM payment_methods WHERE id = $1 AND scope = 'expense'`,
          [dto.paymentMethodId],
        ),
      );
      if (!method) {
        throw new BadRequestException(
          'That is not an expense payment method (BR-62).',
        );
      }
    }

    const inserted: unknown = await manager.query(
      `INSERT INTO expenses (date, expense_category_id, description, amount,
                             paid_to, receipt_number, payment_method_id, notes,
                             shop_id, created_by_id, updated_by_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $10)
       RETURNING id::text`,
      [
        dto.date,
        dto.expenseCategoryId,
        dto.description,
        dto.amount,
        dto.paidTo ?? '',
        dto.receiptNumber ?? '',
        dto.paymentMethodId ?? null,
        dto.notes ?? '',
        dto.shopId ?? null,
        actorId,
      ],
    );
    const id = firstRow<{ id: string }>(inserted)!.id;

    await this.ledger.post(manager, {
      entryType: 'debit',
      source: 'expense',
      reference: expenseLedgerRef(id),
      amount: dto.amount,
      description: dto.description.slice(0, 200),
    });

    return id;
  }

  /** BR-33 — only managers may edit. Enforced by the controller's decorator. */
  async update(
    id: string,
    dto: UpdateExpenseDto,
    actorId: string | null,
  ): Promise<Record<string, unknown>> {
    await this.transactions.run(async (manager) => {
      const sets: string[] = [];
      const params: unknown[] = [];
      const set = (column: string, value: unknown) => {
        params.push(value);
        sets.push(`${column} = $${params.length}`);
      };

      if (dto.date !== undefined) set('date', dto.date);
      if (dto.amount !== undefined) set('amount', dto.amount);
      if (dto.description !== undefined) set('description', dto.description);
      if (dto.expenseCategoryId !== undefined)
        set('expense_category_id', dto.expenseCategoryId);
      if (dto.paymentMethodId !== undefined)
        set('payment_method_id', dto.paymentMethodId);
      if (dto.paidTo !== undefined) set('paid_to', dto.paidTo);
      if (dto.receiptNumber !== undefined)
        set('receipt_number', dto.receiptNumber);
      if (dto.notes !== undefined) set('notes', dto.notes);
      if (dto.shopId !== undefined) set('shop_id', dto.shopId);
      if (sets.length === 0) return;

      set('updated_by_id', actorId);
      params.push(id);

      const updated: unknown = await manager.query(
        `UPDATE expenses SET ${sets.join(', ')} WHERE id = $${params.length} RETURNING id`,
        params,
      );
      if (affectedRows(updated) === 0) {
        throw new NotFoundException('No such expense.');
      }

      // BR-40 — the ledger follows the record it describes.
      if (dto.amount !== undefined || dto.description !== undefined) {
        await this.ledger.updateAmount(
          manager,
          'expense',
          expenseLedgerRef(id),
          dto.amount ?? (await this.currentAmount(manager, id)),
          dto.description?.slice(0, 200),
        );
      }
    });

    return this.findOne(id);
  }

  async remove(id: string): Promise<void> {
    await this.transactions.run(async (manager) => {
      const deleted: unknown = await manager.query(
        `DELETE FROM expenses WHERE id = $1 RETURNING id`,
        [id],
      );
      if (affectedRows(deleted) === 0) {
        throw new NotFoundException('No such expense.');
      }
      await this.ledger.remove(manager, 'expense', expenseLedgerRef(id));
    });
  }

  private async currentAmount(
    manager: EntityManager,
    id: string,
  ): Promise<string> {
    const row = firstRow<{ amount: string }>(
      await manager.query(`SELECT amount::text FROM expenses WHERE id = $1`, [
        id,
      ]),
    );
    return row!.amount;
  }
}
