import {
  BadRequestException,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { affectedRows, firstRow, rowsOf } from '../../common/sql';
import { TransactionService } from '../../common/transaction';
import type { AuthUser } from '../auth/auth-user';
import {
  CLEANABLE,
  type Cleanable,
  type UpdateBusinessSettingsDto,
} from './dto';

/**
 * BR-43's phrase. Deliberately long, specific and unguessable-by-accident: a
 * confirmation someone can type without reading is not a confirmation.
 */
export const CLEANUP_PHRASE = 'DELETE ALL SELECTED DATA';

/**
 * BR-44's *second, different* phrase. Different on purpose — if it were the
 * same string, pasting the first one twice would defeat the protection it
 * exists to provide.
 */
export const INCLUDE_ADMINS_PHRASE = 'YES REMOVE ADMINISTRATOR ACCOUNTS';

/**
 * The tables each target clears, in dependency order.
 *
 * Written out rather than relying on `CASCADE`, because since migration 016
 * every reference table carries `created_by_id -> users` and a cascading
 * TRUNCATE of `users` would take the seeded vocabularies with it — leaving a
 * database nothing can be inserted into.
 */
const TARGET_TABLES: Record<Cleanable, string[]> = {
  sales: [
    'customer_payment_allocations',
    'customer_payment_batches',
    'sale_payments',
    'sale_items',
    'sales',
  ],
  customers: ['customers'],
  inventory: ['stock_histories', 'inventory_items'],
  suppliers: ['supplier_purchase_payments', 'supplier_purchases', 'suppliers'],
  expenses: ['expenses'],
  billClaims: ['bill_claims'],
  ledger: ['ledger_entries'],
  users: ['users'],
};

/**
 * What each target cannot be cleared without.
 *
 * These are not conveniences — each one is a rule the database will enforce
 * anyway, and discovering it halfway through a destructive operation is the
 * worst time:
 *
 *  - **expenses → billClaims**: deleting an expense nulls `bill_claims.expense_id`
 *    (ON DELETE SET NULL), which leaves an *approved* claim with no expense and
 *    violates `billclaim_review_consistent` (BR-36).
 *  - **users → billClaims**: `bill_claims.user_id` is RESTRICT (H-12), so a
 *    person who has ever claimed cannot be removed while the claim stands.
 *  - **inventory → sales**: `sale_items.inventory_item_id` is RESTRICT (BR-27) —
 *    a product that has been sold cannot be deleted out from under the sale.
 *  - **suppliers → inventory**: `inventory_items.supplier_id` is RESTRICT (BR-60).
 *  - **customers → sales**: deleting a customer cascades to their sales (BR-21),
 *    so the count would otherwise under-report what is actually destroyed.
 *
 * The tool **refuses** rather than quietly widening the selection: a
 * destructive operation must never remove more than was asked for.
 */
const REQUIRES: Partial<Record<Cleanable, Cleanable[]>> = {
  expenses: ['billClaims'],
  users: ['billClaims'],
  inventory: ['sales'],
  suppliers: ['inventory'],
  customers: ['sales'],
};

@Injectable()
export class AdminService {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly transactions: TransactionService,
  ) {}

  // ---- FR-10.1 business settings -------------------------------------

  async settings(): Promise<Record<string, unknown>> {
    return firstRow<Record<string, unknown>>(
      await this.dataSource.query(
        `SELECT id::text, name, address, phone, email, logo, invoice_footer
           FROM business_settings WHERE id = 1`,
      ),
    )!;
  }

  async updateSettings(
    dto: UpdateBusinessSettingsDto,
    actorId: string | null,
  ): Promise<Record<string, unknown>> {
    const sets: string[] = [];
    const params: unknown[] = [];
    const set = (column: string, value: unknown) => {
      params.push(value);
      sets.push(`${column} = $${params.length}`);
    };
    if (dto.name !== undefined) set('name', dto.name);
    if (dto.address !== undefined) set('address', dto.address);
    if (dto.phone !== undefined) set('phone', dto.phone);
    if (dto.email !== undefined) set('email', dto.email);
    if (dto.logo !== undefined) set('logo', dto.logo);
    if (dto.invoiceFooter !== undefined)
      set('invoice_footer', dto.invoiceFooter);
    if (sets.length === 0) return this.settings();

    set('updated_by_id', actorId);
    await this.dataSource.query(
      `UPDATE business_settings SET ${sets.join(', ')} WHERE id = 1`,
      params,
    );
    return this.settings();
  }

  // ---- FR-10.3 data cleanup ------------------------------------------

  /**
   * BR-42 — switched off by default in production; it must be deliberately
   * enabled by configuration.
   *
   * The default is *off*, and production has to be opted out of explicitly.
   * Defaulting to on in development is a convenience, but a deployment that
   * forgets to set the variable gets the safe answer.
   */
  private assertEnabled(): void {
    const enabled = process.env.ENABLE_DATA_CLEANUP === 'true';
    if (!enabled) {
      throw new ForbiddenException(
        'The data cleanup tool is disabled. It must be deliberately enabled ' +
          'with ENABLE_DATA_CLEANUP=true.',
      );
    }
  }

  /**
   * FR-10.3 — clear selected data, behind four independent safeguards.
   *
   * Without a confirmation phrase this is a **preview**: it reports exactly what
   * would be removed and writes nothing (BR-43). That is the default reading of
   * an ambiguous request, as it is for the ledger rebuild.
   */
  async cleanData(
    targets: Cleanable[],
    user: AuthUser,
    confirmation?: string,
    includeAdminsConfirmation?: string,
  ): Promise<Record<string, unknown>> {
    // BR-41 — restricted to superusers. Checked here as well as by the route's
    // decorator, because this is the one operation where a missed guard is
    // unrecoverable.
    if (!user.isSuperuser) {
      throw new ForbiddenException(
        'The data cleanup tool is restricted to administrators.',
      );
    }
    this.assertEnabled();

    if (targets.length === 0) {
      throw new BadRequestException('Choose at least one thing to clear.');
    }

    this.assertDependenciesSelected(targets);

    const includeAdmins = includeAdminsConfirmation === INCLUDE_ADMINS_PHRASE;
    const counts = await this.countTargets(targets, user, includeAdmins);
    const preview = confirmation !== CLEANUP_PHRASE;

    if (preview) {
      return {
        preview: true,
        targets,
        wouldRemove: counts,
        totalRows: Object.values(counts).reduce((a, b) => a + b, 0),
        protections: this.protections(user, includeAdmins),
        ...(await this.ledgerWarning(targets)),
        confirmationRequired: CLEANUP_PHRASE,
        ...(confirmation !== undefined && confirmation !== CLEANUP_PHRASE
          ? { error: 'The confirmation phrase did not match exactly.' }
          : {}),
      };
    }

    const removed = await this.transactions.run(async (manager) => {
      const tally: Record<string, number> = {};
      /**
       * Order matters: a table must go before whatever it depends on. Claims
       * reference both expenses and users, sales reference inventory, and
       * `users` is referenced by nearly everything, so it goes last.
       */
      const ORDER: Cleanable[] = [
        'billClaims',
        'ledger',
        'expenses',
        'sales',
        'customers',
        'inventory',
        'suppliers',
        'users',
      ];
      const ordered = ORDER.filter((t) => targets.includes(t));

      for (const target of ordered) {
        for (const table of TARGET_TABLES[target]) {
          if (table === 'users') {
            /**
             * BR-44 — administrator accounts are preserved unless explicitly
             * selected, and the account currently signed in is protected by
             * default. Overriding that needs the second phrase, and even then
             * the caller's own account is kept: deleting the session you are
             * using mid-request is not something to offer.
             */
            const result: unknown = await manager.query(
              `DELETE FROM users u
                WHERE u.id <> $1
                  AND ($2::boolean OR NOT EXISTS (
                        SELECT 1 FROM user_types t
                         WHERE t.id = u.user_type_id AND t.is_superuser))
                RETURNING u.id`,
              [user.id, includeAdmins],
            );
            tally[table] = affectedRows(result);
            continue;
          }
          const result: unknown = await manager.query(
            `DELETE FROM ${table} RETURNING id`,
          );
          tally[table] = affectedRows(result);
        }
      }
      return tally;
    });

    return {
      preview: false,
      targets,
      removed,
      totalRows: Object.values(removed).reduce((a, b) => a + b, 0),
      protections: this.protections(user, includeAdmins),
      ...(await this.ledgerWarning(targets)),
    };
  }

  /**
   * Refuse a selection the database would reject part-way through.
   *
   * Checked before the preview as well as before the deletion, so the preview
   * never promises a run that cannot happen.
   */
  private assertDependenciesSelected(targets: Cleanable[]): void {
    const selected = new Set(targets);
    const missing: string[] = [];

    for (const target of targets) {
      for (const dependency of REQUIRES[target] ?? []) {
        if (!selected.has(dependency)) {
          missing.push(`"${target}" also requires "${dependency}"`);
        }
      }
    }

    if (missing.length > 0) {
      throw new BadRequestException(
        `That selection would be refused by the database part-way through. ` +
          `${missing.join('; ')}. Add them to the selection, or clear less — ` +
          `nothing is widened for you, because a destructive tool must not ` +
          `remove more than was asked.`,
      );
    }
  }

  /**
   * Clearing money records without clearing the ledger leaves **orphans** —
   * ledger lines whose underlying record is gone, which is money in the balance
   * that is not in the records.
   *
   * The tool does not widen the selection to fix it (see
   * `assertDependenciesSelected`), but it must not stay quiet about it either.
   * `POST /api/ledger/rebuild` reports the same orphans afterwards.
   */
  private async ledgerWarning(
    targets: Cleanable[],
  ): Promise<Record<string, unknown>> {
    const clearsMoney = targets.some((t) =>
      ['expenses', 'sales', 'suppliers'].includes(t),
    );
    if (!clearsMoney || targets.includes('ledger')) return {};

    const row = firstRow<{ n: string }>(
      await this.dataSource.query(
        `SELECT count(*)::text AS n FROM ledger_entries`,
      ),
    );
    return {
      ledgerWarning:
        `The ledger is not in this selection, so its ${row?.n ?? '0'} entries ` +
        `will be left referring to records that no longer exist. That is money ` +
        `in the balance which is not in the records. Add "ledger" to the ` +
        `selection, or check POST /api/ledger/rebuild afterwards — it reports ` +
        `the orphans but cannot repair them.`,
    };
  }

  private protections(user: AuthUser, includeAdmins: boolean): string[] {
    const notes = [`Your own account (${user.username}) is never deleted.`];
    notes.push(
      includeAdmins
        ? 'Administrator accounts WILL be removed — the override phrase was given.'
        : 'Administrator accounts are preserved.',
    );
    return notes;
  }

  private async countTargets(
    targets: Cleanable[],
    user: AuthUser,
    includeAdmins: boolean,
  ): Promise<Record<string, number>> {
    const counts: Record<string, number> = {};
    for (const target of targets) {
      for (const table of TARGET_TABLES[target]) {
        if (table === 'users') {
          const row = firstRow<{ n: string }>(
            await this.dataSource.query(
              `SELECT count(*)::text AS n FROM users u
                WHERE u.id <> $1
                  AND ($2::boolean OR NOT EXISTS (
                        SELECT 1 FROM user_types t
                         WHERE t.id = u.user_type_id AND t.is_superuser))`,
              [user.id, includeAdmins],
            ),
          );
          counts[table] = Number(row?.n ?? '0');
          continue;
        }
        const row = firstRow<{ n: string }>(
          await this.dataSource.query(
            `SELECT count(*)::text AS n FROM ${table}`,
          ),
        );
        counts[table] = Number(row?.n ?? '0');
      }
    }
    return counts;
  }

  /** The groups a cleanup screen can offer, with what each covers. */
  cleanableTargets(): Array<{ target: string; tables: string[] }> {
    return CLEANABLE.map((target) => ({
      target,
      tables: TARGET_TABLES[target],
    }));
  }

  /** FR-10.2 — the role groups and their baseline grants, as configured. */
  async roles(): Promise<Array<Record<string, unknown>>> {
    return rowsOf(
      await this.dataSource.query(
        `SELECT t.id::text, t.code, t.label, t.is_superuser, t.is_manager,
                count(utp.permission_id)::text AS permission_count,
                (SELECT count(*)::text FROM users u WHERE u.user_type_id = t.id)
                  AS account_count
           FROM user_types t
           LEFT JOIN user_type_permissions utp ON utp.user_type_id = t.id
          GROUP BY t.id ORDER BY t.sort_order`,
      ),
    );
  }
}
