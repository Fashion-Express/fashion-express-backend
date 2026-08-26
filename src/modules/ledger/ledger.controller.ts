import { Body, Controller, Get, Post, Query } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { PAGE_SIZE, toPage } from '../../common/pagination';
import { firstRow, rowsOf } from '../../common/sql';
import { RequireManager, RequirePermission } from '../auth/decorators';
import { ListLedgerQuery, RebuildLedgerQuery } from './dto';
import {
  LedgerRebuildService,
  type RebuildReport,
} from './ledger-rebuild.service';

/**
 * FR-08 — the ledger, read side.
 *
 * **Manager-only** (FR-09.5). And **read-only**: BR-38 says no user posts a
 * ledger line by hand, so there is deliberately no POST, PATCH or DELETE for
 * entries. Lines appear because money moved somewhere else in the system.
 */
@Controller('ledger')
@RequireManager()
export class LedgerController {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly rebuild: LedgerRebuildService,
  ) {}

  /**
   * FR-08.2 — entries newest first, with total credits, total debits and the
   * current balance.
   *
   * The totals are over the **whole ledger**, not the filtered page: "the
   * current balance" means the business's balance, and a filtered subtotal
   * would be a different and much more confusing number under the same label.
   * `filtered` carries the subtotal separately for whatever the caller asked.
   */
  @Get()
  @RequirePermission('view_ledger')
  async list(@Query() query: ListLedgerQuery) {
    const where: string[] = [];
    const params: unknown[] = [];

    if (query.entryType) {
      params.push(query.entryType);
      where.push(`t.code = $${params.length}`);
    }
    if (query.source) {
      params.push(query.source);
      where.push(`s.code = $${params.length}`);
    }
    if (query.reference) {
      params.push(`%${query.reference}%`);
      where.push(`e.reference ILIKE $${params.length}`);
    }
    if (query.from) {
      params.push(query.from);
      where.push(`e.timestamp >= $${params.length}`);
    }
    if (query.to) {
      params.push(query.to);
      where.push(`e.timestamp < ($${params.length}::date + 1)`);
    }

    const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const size = PAGE_SIZE.ledger;
    const page = query.page && query.page > 0 ? query.page : 1;

    const base = `FROM ledger_entries e
                    JOIN ledger_entry_types t ON t.id = e.entry_type_id
                    JOIN ledger_sources s ON s.id = e.source_id`;

    const counted = firstRow<{ count: string }>(
      await this.dataSource.query(
        `SELECT count(*)::text AS count ${base} ${clause}`,
        params,
      ),
    );

    const items = rowsOf(
      await this.dataSource.query(
        `SELECT e.id::text, e.timestamp, t.code AS entry_type, t.label AS entry_type_label,
                t.direction, s.code AS source, s.label AS source_label,
                e.reference, e.description, e.amount::text,
                -- the signed value, so a client need not re-derive it
                (e.amount * t.direction)::text AS signed_amount
           ${base} ${clause}
          ORDER BY e.timestamp DESC, e.id DESC
          LIMIT ${size} OFFSET ${(page - 1) * size}`,
        params,
      ),
    );

    /**
     * FR-12.12.2 — the balance is `SUM(amount * direction)`, not a comparison
     * against the literal 'credit'. The definition of a credit lives in one row
     * of `ledger_entry_types`, and this reads it.
     */
    const totals = firstRow<Record<string, string>>(
      await this.dataSource.query(
        `SELECT COALESCE(SUM(e.amount) FILTER (WHERE t.direction = 1), 0)::text  AS total_credits,
                COALESCE(SUM(e.amount) FILTER (WHERE t.direction = -1), 0)::text AS total_debits,
                COALESCE(SUM(e.amount * t.direction), 0)::text                   AS balance
           ${base}`,
      ),
    )!;

    const filtered = firstRow<Record<string, string>>(
      await this.dataSource.query(
        `SELECT COALESCE(SUM(e.amount * t.direction), 0)::text AS net,
                COALESCE(SUM(e.amount), 0)::text AS gross
           ${base} ${clause}`,
        params,
      ),
    )!;

    return {
      ...toPage(items, Number(counted?.count ?? '0'), page, size),
      totals,
      filtered,
    };
  }

  /**
   * FR-08.3 — rebuild from the underlying records.
   *
   * Defaults to **preview**: it reports what it would post and writes nothing.
   * Pass `preview=false` to actually write. Safe to run repeatedly either way,
   * because every post is `ON CONFLICT DO NOTHING` on `(source_id, reference)`
   * (BR-39) — a rebuild reconciles, it does not duplicate.
   */
  @Post('rebuild')
  @RequirePermission('rebuild_ledger')
  run(
    @Query() query: RebuildLedgerQuery,
    @Body() body: RebuildLedgerQuery,
  ): Promise<RebuildReport> {
    const requested = body?.preview ?? query.preview;
    return this.rebuild.rebuild(requested !== false);
  }
}
