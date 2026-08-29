import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, EntityManager } from 'typeorm';
import { PAGE_SIZE, type Page, toPage } from '../../common/pagination';
import { affectedRows, firstRow, rowsOf } from '../../common/sql';
import { TransactionService } from '../../common/transaction';
import type { AuthUser } from '../auth/auth-user';
import { ExpensesService } from '../expenses/expenses.service';
import type {
  CreateBillClaimDto,
  ListBillClaimsQuery,
  ReviewBillClaimDto,
  UpdateBillClaimDto,
} from './dto';

export interface ClaimRow {
  id: string;
  amount: string;
  description: string;
  bill_date: string;
  status_code: string;
  status_label: string;
  attachment: string | null;
  approval_date: string | null;
  user_id: string;
  submitted_by: string;
  approved_by: string | null;
  expense_id: string | null;
}

const SELECT_CLAIM = `
  SELECT bc.id::text, bc.amount::text, bc.description, bc.bill_date::text,
         bc.status_code, st.label AS status_label, bc.attachment,
         bc.approval_date::text, bc.user_id::text,
         submitter.username AS submitted_by,
         approver.username  AS approved_by,
         bc.expense_id::text
    FROM bill_claims bc
    JOIN statuses st ON st.id = bc.status_id AND st.scope = 'claim'
    JOIN users submitter ON submitter.id = bc.user_id
    LEFT JOIN users approver ON approver.id = bc.approved_by_id`;

@Injectable()
export class BillClaimsService {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly transactions: TransactionService,
    private readonly expenses: ExpensesService,
  ) {}

  /**
   * FR-07.3 / FR-07.4 — staff see their own claims, managers see everyone's.
   *
   * Unlike BR-01 on sales, this is not a blanket rule: `review_bills` is what
   * widens the view, because reviewing is the job that needs it. A staff member
   * without it is scoped to their own claims however they ask.
   */
  private scope(user: AuthUser, params: unknown[]): string | null {
    if (user.isSuperuser || user.permissions.has('review_bills')) return null;
    params.push(user.id);
    return `bc.user_id = $${params.length}`;
  }

  async list(
    query: ListBillClaimsQuery,
    user: AuthUser,
  ): Promise<Page<ClaimRow> & { totals: Record<string, string> }> {
    const where: string[] = [];
    const params: unknown[] = [];

    const scope = this.scope(user, params);
    if (scope) where.push(scope);

    if (query.status) {
      params.push(query.status);
      where.push(`bc.status_code = $${params.length}`);
    }
    if (query.userId) {
      params.push(query.userId);
      where.push(`bc.user_id = $${params.length}`);
    }
    if (query.search) {
      params.push(`%${query.search}%`);
      const n = params.length;
      where.push(
        `(submitter.username ILIKE $${n} OR bc.description ILIKE $${n})`,
      );
    }

    const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const size = PAGE_SIZE.expenses;
    const page = query.page && query.page > 0 ? query.page : 1;

    const counted = firstRow<{ count: string }>(
      await this.dataSource.query(
        `SELECT count(*)::text AS count FROM bill_claims bc
           JOIN users submitter ON submitter.id = bc.user_id ${clause}`,
        params,
      ),
    );

    const rows = rowsOf<ClaimRow>(
      await this.dataSource.query(
        `${SELECT_CLAIM} ${clause} ORDER BY bc.created_at DESC
          LIMIT ${size} OFFSET ${(page - 1) * size}`,
        params,
      ),
    );

    /**
     * FR-07.4 — the totals for pending, approved and rejected shown together.
     * They respect the same scope, so a staff member sees their own three
     * figures and a reviewer sees everyone's.
     */
    const totals = firstRow<Record<string, string>>(
      await this.dataSource.query(
        `SELECT COALESCE(SUM(bc.amount) FILTER (WHERE bc.status_code = 'pending'), 0)::text  AS pending,
                COALESCE(SUM(bc.amount) FILTER (WHERE bc.status_code = 'approved'), 0)::text AS approved,
                COALESCE(SUM(bc.amount) FILTER (WHERE bc.status_code = 'rejected'), 0)::text AS rejected,
                count(*) FILTER (WHERE bc.status_code = 'pending')::text AS pending_count
           FROM bill_claims bc
           JOIN users submitter ON submitter.id = bc.user_id ${clause}`,
        params,
      ),
    )!;

    return {
      ...toPage(rows, Number(counted?.count ?? '0'), page, size),
      totals,
    };
  }

  async findOne(id: string, user: AuthUser): Promise<ClaimRow> {
    const params: unknown[] = [id];
    const scope = this.scope(user, params);
    const row = firstRow<ClaimRow>(
      await this.dataSource.query(
        `${SELECT_CLAIM} WHERE bc.id = $1${scope ? ` AND ${scope}` : ''}`,
        params,
      ),
    );
    if (!row) throw new NotFoundException('No such claim.');
    return row;
  }

  /**
   * FR-07.1 — submit a claim. It starts `pending`, and the status pair is
   * written from one helper so `status_id` and `status_code` cannot disagree
   * (BR-65).
   */
  async create(
    dto: CreateBillClaimDto,
    attachment: string | null,
    user: AuthUser,
  ): Promise<ClaimRow> {
    const id = await this.transactions.run(async (manager) => {
      const status = await this.claimStatus(manager, 'pending');
      const inserted: unknown = await manager.query(
        `INSERT INTO bill_claims (user_id, amount, description, bill_date,
                                  status_id, status_code, attachment,
                                  created_by_id, updated_by_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $1, $1)
         RETURNING id::text`,
        [
          user.id,
          dto.amount,
          dto.description,
          dto.billDate,
          status.id,
          status.code,
          attachment,
        ],
      );
      return firstRow<{ id: string }>(inserted)!.id;
    });
    return this.findOne(id, user);
  }

  /** A claim may only be edited by its owner, and only while pending. */
  async update(
    id: string,
    dto: UpdateBillClaimDto,
    attachment: string | null,
    user: AuthUser,
  ): Promise<ClaimRow> {
    const claim = await this.findOne(id, user);
    if (claim.user_id !== user.id && !user.isSuperuser) {
      throw new ForbiddenException('You may only edit your own claims.');
    }
    if (claim.status_code !== 'pending') {
      throw new BadRequestException(
        `This claim has already been ${claim.status_label.toLowerCase()} and cannot be changed.`,
      );
    }

    const sets: string[] = [];
    const params: unknown[] = [];
    const set = (column: string, value: unknown) => {
      params.push(value);
      sets.push(`${column} = $${params.length}`);
    };
    if (dto.amount !== undefined) set('amount', dto.amount);
    if (dto.description !== undefined) set('description', dto.description);
    if (dto.billDate !== undefined) set('bill_date', dto.billDate);
    if (attachment) set('attachment', attachment);
    if (sets.length === 0) return claim;

    set('updated_by_id', user.id);
    params.push(id);
    await this.dataSource.query(
      `UPDATE bill_claims SET ${sets.join(', ')} WHERE id = $${params.length}`,
      params,
    );
    return this.findOne(id, user);
  }

  /**
   * BR-36 — approving a claim must, **as one action**: mark it approved, record
   * who approved it and when, create an expense dated to the bill date with the
   * employee as payee, and link the claim to that expense so either can be
   * traced from the other.
   *
   * All of it in one transaction. `billclaim_review_consistent` then makes any
   * half-done result unrepresentable: an approved claim without an expense, or
   * with no review date, is refused by the database.
   */
  async approve(
    id: string,
    dto: ReviewBillClaimDto,
    user: AuthUser,
  ): Promise<ClaimRow> {
    await this.transactions.run(async (manager) => {
      const claim = await this.lockPending(manager, id);

      const categoryId =
        dto.expenseCategoryId ?? (await this.defaultCategory(manager));

      const expenseId = await this.expenses.write(
        manager,
        {
          // Dated to the *bill* date, not today: the cost belongs to when it
          // was incurred.
          date: claim.bill_date,
          amount: claim.amount,
          description: claim.description,
          expenseCategoryId: categoryId,
          // The employee is the payee — they are the one being reimbursed.
          paidTo: claim.submitted_by,
          notes: dto.notes ?? `Reimbursement of claim #${id}`,
        },
        user.id,
      );

      const status = await this.claimStatus(manager, 'approved');
      await manager.query(
        `UPDATE bill_claims
            SET status_id = $1, status_code = $2,
                approved_by_id = $3, approval_date = CURRENT_DATE,
                expense_id = $4, updated_by_id = $3
          WHERE id = $5`,
        [status.id, status.code, user.id, expenseId, id],
      );
    });

    return this.findOne(id, user);
  }

  /** BR-37 — rejecting records the reviewer and the date and creates **no** expense. */
  async reject(id: string, user: AuthUser): Promise<ClaimRow> {
    await this.transactions.run(async (manager) => {
      await this.lockPending(manager, id);
      const status = await this.claimStatus(manager, 'rejected');
      await manager.query(
        `UPDATE bill_claims
            SET status_id = $1, status_code = $2,
                approved_by_id = $3, approval_date = CURRENT_DATE,
                updated_by_id = $3
          WHERE id = $4`,
        [status.id, status.code, user.id, id],
      );
    });
    return this.findOne(id, user);
  }

  async remove(id: string, user: AuthUser): Promise<void> {
    const claim = await this.findOne(id, user);
    if (claim.status_code !== 'pending') {
      throw new BadRequestException(
        'A reviewed claim cannot be deleted — it is part of the expense record.',
      );
    }
    if (claim.user_id !== user.id && !user.isSuperuser) {
      throw new ForbiddenException('You may only withdraw your own claims.');
    }
    const deleted: unknown = await this.dataSource.query(
      `DELETE FROM bill_claims WHERE id = $1 RETURNING id`,
      [id],
    );
    if (affectedRows(deleted) === 0)
      throw new NotFoundException('No such claim.');
  }

  /**
   * BR-35 — a claim already approved or rejected cannot be processed again.
   *
   * The row is locked so two reviewers cannot both read it as pending and both
   * act; the constraint would catch the second write, but the lock gives the
   * loser a sentence instead of a constraint violation.
   */
  private async lockPending(
    manager: EntityManager,
    id: string,
  ): Promise<{
    amount: string;
    description: string;
    bill_date: string;
    submitted_by: string;
  }> {
    const claim = firstRow<{
      status_code: string;
      status_label: string;
      amount: string;
      description: string;
      bill_date: string;
      submitted_by: string;
    }>(
      await manager.query(
        `SELECT bc.status_code, st.label AS status_label, bc.amount::text,
                bc.description, bc.bill_date::text, u.username AS submitted_by
           FROM bill_claims bc
           JOIN statuses st ON st.id = bc.status_id AND st.scope = 'claim'
           JOIN users u ON u.id = bc.user_id
          WHERE bc.id = $1
            FOR UPDATE OF bc`,
        [id],
      ),
    );
    if (!claim) throw new NotFoundException('No such claim.');
    if (claim.status_code !== 'pending') {
      throw new BadRequestException(
        `This claim has already been ${claim.status_label.toLowerCase()} and ` +
          `cannot be processed again.`,
      );
    }
    return claim;
  }

  private async claimStatus(
    manager: EntityManager,
    code: 'pending' | 'approved' | 'rejected',
  ): Promise<{ id: string; code: string }> {
    const row = firstRow<{ id: string }>(
      await manager.query(
        `SELECT id::text FROM statuses WHERE scope = 'claim' AND code = $1`,
        [code],
      ),
    );
    if (!row) throw new BadRequestException(`Unknown claim status "${code}".`);
    return { id: row.id, code };
  }

  /** Reimbursements land under `salary` unless the reviewer says otherwise. */
  private async defaultCategory(manager: EntityManager): Promise<string> {
    const row = firstRow<{ id: string }>(
      await manager.query(
        `SELECT id::text FROM expense_categories
          WHERE code IN ('salary', 'other') ORDER BY code = 'salary' DESC LIMIT 1`,
      ),
    );
    if (!row) {
      throw new BadRequestException(
        'No expense category is available to file this reimbursement under.',
      );
    }
    return row.id;
  }
}
