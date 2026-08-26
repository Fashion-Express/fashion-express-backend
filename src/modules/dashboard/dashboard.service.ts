import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { firstRow, rowsOf } from '../../common/sql';
import type { AuthUser } from '../auth/auth-user';

/**
 * FR-01 — the landing page, assembled live from current records.
 *
 * **FR-01.8 is the rule that shapes every query here.** Every figure is
 * filterable by shop — except expenses and bill claims, which are not
 * shop-scoped (FR-11.4). Those two tiles show business-wide figures whatever
 * shop is selected, and carry a flag saying so, because a number that silently
 * ignores the filter above it is worse than no number.
 */
@Injectable()
export class DashboardService {
  constructor(@InjectDataSource() private readonly dataSource: DataSource) {}

  /**
   * FR-01.7 — users whose only permissions are bill-related see a reduced
   * dashboard offering just "Submit a Bill" and "My Bills".
   *
   * The test is what they *can* do, not what type they hold: someone with only
   * `submit_bill` and `view_my_bills` has nothing else to look at, and showing
   * them empty tiles they cannot populate would be noise.
   */
  private isBillsOnly(user: AuthUser): boolean {
    if (user.isSuperuser || user.isManager) return false;
    const meaningful = [...user.permissions].filter(
      (p) =>
        !p.endsWith('_menu') && p !== 'submit_bill' && p !== 'view_my_bills',
    );
    return meaningful.length === 0;
  }

  async build(
    user: AuthUser,
    shopId?: string,
  ): Promise<Record<string, unknown>> {
    if (this.isBillsOnly(user)) {
      return {
        reduced: true,
        reason:
          'Your permissions cover bill claims only, so the dashboard offers just those.',
        actions: [
          { label: 'Submit a Bill', path: '/api/bill-claims', method: 'POST' },
          { label: 'My Bills', path: '/api/bill-claims', method: 'GET' },
        ],
        myClaims: await this.myClaims(user.id),
      };
    }

    const shopFilter = shopId ? ` AND shop_id = $1` : '';
    const params: unknown[] = shopId ? [shopId] : [];

    return {
      reduced: false,
      shopId: shopId ?? null,
      headline: await this.headline(shopFilter, params),
      sales: await this.saleFigures(shopFilter, params),
      // FR-01.8 — business-wide whatever shop is selected, and flagged.
      businessWide: {
        note:
          'Expenses and bill claims are not scoped to a shop (FR-11.4), so these ' +
          'figures cover the whole business regardless of the shop filter.',
        ...(await this.moneyOut()),
      },
      topProducts: await this.topProducts(shopId),
      lowStock: await this.lowStock(shopId),
      recentSales: await this.recentSales(shopId),
      recentExpenses: await this.recentExpenses(),
    };
  }

  /** FR-01.1 — the headline counts. */
  private async headline(
    shopFilter: string,
    params: unknown[],
  ): Promise<Record<string, string>> {
    const shopScoped = shopFilter.replace('shop_id', 'i.shop_id');
    return firstRow<Record<string, string>>(
      await this.dataSource.query(
        `SELECT
           -- FR-00.7: only accounts whose status is 'active' count.
           (SELECT count(*)::text FROM users u
              JOIN statuses s ON s.id = u.status_id AND s.scope = 'user'
             WHERE s.code = 'active' AND u.is_active) AS active_employees,
           (SELECT count(*)::text FROM customers c
              JOIN statuses s ON s.id = c.status_id AND s.scope = 'customer'
             WHERE s.code = 'active'${shopFilter.replace('shop_id', 'c.shop_id')}) AS active_customers,
           (SELECT count(*)::text FROM inventory_items i WHERE true${shopScoped}) AS inventory_items,
           (SELECT count(*)::text FROM inventory_items i
             WHERE i.quantity <= i.minimum_stock${shopScoped}) AS low_stock_count,
           (SELECT round(COALESCE(SUM(i.quantity * i.unit_price), 0), 2)::text
              FROM inventory_items i WHERE true${shopScoped}) AS stock_value`,
        params,
      ),
    )!;
  }

  /**
   * FR-01.2 — draft and finalised counts, today's finalised total, and the
   * total outstanding.
   *
   * BR-03 — drafts and quotations are excluded from every money figure. The
   * counts include them because a count of drafts is the point of that tile;
   * the *totals* never do.
   *
   * NFR-05 — "today" is the Asia/Dhaka day, not the server's UTC day. At 3am
   * Dhaka time those are different dates and the figure would be wrong.
   */
  private async saleFigures(
    shopFilter: string,
    params: unknown[],
  ): Promise<Record<string, string>> {
    return firstRow<Record<string, string>>(
      await this.dataSource.query(
        `SELECT
           count(*) FILTER (WHERE status_code = 'draft')::text     AS draft_count,
           count(*) FILTER (WHERE status_code = 'quote')::text     AS quotation_count,
           count(*) FILTER (WHERE status_code = 'finalized')::text AS finalized_count,
           COALESCE(SUM(total_amount) FILTER (
             WHERE status_code = 'finalized'
               AND (finalized_at AT TIME ZONE 'Asia/Dhaka')::date
                   = (now() AT TIME ZONE 'Asia/Dhaka')::date), 0)::text AS finalized_today,
           COALESCE(SUM(total_amount) FILTER (WHERE status_code = 'finalized'), 0)::text AS invoiced,
           COALESCE(SUM(total_amount - amount_paid)
                    FILTER (WHERE status_code = 'finalized'), 0)::text AS outstanding
           FROM sales WHERE true${shopFilter}`,
        params,
      ),
    )!;
  }

  /** FR-01.3 — this month's expenses and the claims awaiting review. */
  private async moneyOut(): Promise<Record<string, string>> {
    return firstRow<Record<string, string>>(
      await this.dataSource.query(
        `SELECT
           (SELECT COALESCE(SUM(amount), 0)::text FROM expenses
             WHERE date >= date_trunc('month', (now() AT TIME ZONE 'Asia/Dhaka')::date)
               AND date <  date_trunc('month', (now() AT TIME ZONE 'Asia/Dhaka')::date)
                           + interval '1 month') AS expenses_this_month,
           (SELECT count(*)::text FROM bill_claims WHERE status_code = 'pending')
             AS claims_awaiting_review,
           (SELECT COALESCE(SUM(amount), 0)::text FROM bill_claims
             WHERE status_code = 'pending') AS claims_awaiting_value`,
      ),
    )!;
  }

  /**
   * FR-01.4 — the top 10 products by quantity sold across all finalised sales,
   * covering **both** stocked products and machine lines.
   *
   * Machine lines have no product to group by, so they are grouped by "the
   * first meaningful line of their description" — that is what makes repeat
   * sales of the same machine aggregate into one row instead of scattering. A
   * blank line at the top of a pasted description would otherwise make every
   * sale its own group, hence the filter for the first *non-empty* line.
   */
  private async topProducts(
    shopId?: string,
  ): Promise<Array<Record<string, string>>> {
    const params: unknown[] = [];
    let clause = `WHERE s.status_code = 'finalized'`;
    if (shopId) {
      params.push(shopId);
      clause += ` AND s.shop_id = $${params.length}`;
    }

    return rowsOf(
      await this.dataSource.query(
        `SELECT label, item_type,
                SUM(quantity)::text   AS quantity_sold,
                SUM(line_total)::text AS value_sold
           FROM (
             SELECT
               CASE WHEN i.item_type_code = 'inventory'
                    THEN inv.part_name || ' (' || inv.part_code || ')'
                    ELSE COALESCE(
                      (SELECT btrim(line)
                         FROM regexp_split_to_table(i.description, E'\\n') AS line
                        WHERE btrim(line) <> '' LIMIT 1),
                      '(no description)')
               END AS label,
               i.item_type_code AS item_type,
               i.quantity, i.line_total
               FROM sale_items i
               JOIN sales s ON s.id = i.sale_id
               LEFT JOIN inventory_items inv ON inv.id = i.inventory_item_id
               ${clause}
           ) lines
          GROUP BY label, item_type
          ORDER BY SUM(quantity) DESC
          LIMIT 10`,
        params,
      ),
    );
  }

  /** FR-01.5 — the first five low-stock items (BR-24, per shop under BR-52). */
  private async lowStock(
    shopId?: string,
  ): Promise<Array<Record<string, unknown>>> {
    const params: unknown[] = [];
    let clause = 'WHERE i.quantity <= i.minimum_stock';
    if (shopId) {
      params.push(shopId);
      clause += ` AND i.shop_id = $${params.length}`;
    }
    return rowsOf(
      await this.dataSource.query(
        `SELECT i.id::text, i.part_code, i.part_name, i.quantity::text,
                i.minimum_stock, sh.name AS shop_name
           FROM inventory_items i JOIN shops sh ON sh.id = i.shop_id
           ${clause} ORDER BY i.quantity LIMIT 5`,
        params,
      ),
    );
  }

  private async recentSales(
    shopId?: string,
  ): Promise<Array<Record<string, unknown>>> {
    const params: unknown[] = [];
    const clause = shopId ? `WHERE s.shop_id = $1` : '';
    if (shopId) params.push(shopId);
    return rowsOf(
      await this.dataSource.query(
        `SELECT s.id::text, s.sale_number, s.status_code, s.total_amount::text,
                c.name AS customer_name, s.created_at
           FROM sales s JOIN customers c ON c.id = s.customer_id
           ${clause} ORDER BY s.created_at DESC LIMIT 5`,
        params,
      ),
    );
  }

  private async recentExpenses(): Promise<Array<Record<string, unknown>>> {
    return rowsOf(
      await this.dataSource.query(
        `SELECT e.id::text, e.date::text, e.description, e.amount::text,
                ec.label AS category_label
           FROM expenses e JOIN expense_categories ec ON ec.id = e.expense_category_id
          ORDER BY e.date DESC, e.created_at DESC LIMIT 5`,
      ),
    );
  }

  private async myClaims(userId: string): Promise<Record<string, string>> {
    return firstRow<Record<string, string>>(
      await this.dataSource.query(
        `SELECT count(*) FILTER (WHERE status_code = 'pending')::text  AS pending,
                count(*) FILTER (WHERE status_code = 'approved')::text AS approved,
                count(*) FILTER (WHERE status_code = 'rejected')::text AS rejected
           FROM bill_claims WHERE user_id = $1`,
        [userId],
      ),
    )!;
  }

  /**
   * FR-01.6 — a low-stock count must be visible on **every page**, not only the
   * dashboard. This is the cheap endpoint a layout can poll for the banner; the
   * partial index `idx_inventory_low_stock_shop` exists precisely because it
   * runs on every request.
   */
  async lowStockBanner(shopId?: string): Promise<{ count: number }> {
    const params: unknown[] = [];
    let clause = 'WHERE quantity <= minimum_stock';
    if (shopId) {
      params.push(shopId);
      clause += ` AND shop_id = $${params.length}`;
    }
    const row = firstRow<{ n: string }>(
      await this.dataSource.query(
        `SELECT count(*)::text AS n FROM inventory_items ${clause}`,
        params,
      ),
    );
    return { count: Number(row?.n ?? '0') };
  }
}
