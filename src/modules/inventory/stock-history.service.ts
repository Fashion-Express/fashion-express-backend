import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, EntityManager } from 'typeorm';
import { Decimal } from '../../common/decimal';
import { firstRow, rowsOf } from '../../common/sql';

/**
 * FR-04.5 — the movement log.
 *
 * BR-25: every movement is recorded automatically. Rows are never written by
 * hand and never edited or deleted, so this service is the *only* writer and
 * there is deliberately no update or delete on it.
 *
 * BR-26: unit movements and box movements are separate rows, so the two stock
 * dimensions can be audited independently. `record` therefore writes one row
 * per dimension that actually moved — collapsing them would make a five-unit
 * movement indistinguishable from a five-box one when reconciling.
 *
 * Phase 5's sale finalisation writes through here too; the reasons in
 * FR-04.5.1's table are the vocabulary.
 */

export type MovementType = 'in' | 'out' | 'adjustment';

export interface MovementInput {
  itemId: string;
  type: MovementType;
  reason: string;
  actorId: string | null;
  /** Loose units before and after. Omit when only boxes moved. */
  units?: { previous: string; next: string };
  /** Whole boxes before and after. Omit when only units moved. */
  boxes?: { previous: number; next: number };
}

@Injectable()
export class StockHistoryService {
  private typeIds = new Map<string, string>();

  constructor(@InjectDataSource() private readonly dataSource: DataSource) {}

  private async typeId(
    manager: EntityManager,
    code: MovementType,
  ): Promise<string> {
    if (this.typeIds.size === 0) {
      for (const row of rowsOf<{ id: string; code: string }>(
        await manager.query(`SELECT id::text, code FROM transaction_types`),
      )) {
        this.typeIds.set(row.code, row.id);
      }
    }
    return this.typeIds.get(code)!;
  }

  /**
   * Write the movement rows for one change. Call inside the transaction that
   * changed the stock, so a movement can never exist without its effect.
   */
  async record(manager: EntityManager, input: MovementInput): Promise<void> {
    const typeId = await this.typeId(manager, input.type);

    if (input.units) {
      const previous = new Decimal(input.units.previous);
      const next = new Decimal(input.units.next);
      if (!previous.equals(next)) {
        await manager.query(
          `INSERT INTO stock_histories
             (item_id, transaction_type_id, quantity, previous_quantity, new_quantity,
              box_quantity, previous_box_quantity, new_box_quantity,
              reason, created_by_id)
           VALUES ($1, $2, $3, $4, $5, 0, 0, 0, $6, $7)`,
          [
            input.itemId,
            typeId,
            // The movement is recorded as an absolute amount; the direction is
            // carried by the transaction type (FR-12.7.2).
            next.minus(previous).abs().toFixed(3),
            previous.toFixed(3),
            next.toFixed(3),
            input.reason,
            input.actorId,
          ],
        );
      }
    }

    if (input.boxes) {
      const { previous, next } = input.boxes;
      if (previous !== next) {
        await manager.query(
          `INSERT INTO stock_histories
             (item_id, transaction_type_id, quantity, previous_quantity, new_quantity,
              box_quantity, previous_box_quantity, new_box_quantity,
              reason, created_by_id)
           VALUES ($1, $2, 0, 0, 0, $3, $4, $5, $6, $7)`,
          [
            input.itemId,
            typeId,
            Math.abs(next - previous),
            previous,
            next,
            input.reason,
            input.actorId,
          ],
        );
      }
    }
  }

  /** FR-04.5 — paginated at 20 (RD-12). */
  async forItem(
    itemId: string,
    page = 1,
  ): Promise<{
    items: Array<Record<string, unknown>>;
    total: number;
    page: number;
    pageSize: number;
  }> {
    const size = 20;
    const counted = firstRow<{ count: string }>(
      await this.dataSource.query(
        `SELECT count(*)::text AS count FROM stock_histories WHERE item_id = $1`,
        [itemId],
      ),
    );

    const items = rowsOf(
      await this.dataSource.query(
        `SELECT h.id::text, h.created_at,
                t.code AS type_code, t.label AS type_label, t.direction,
                h.quantity::text, h.previous_quantity::text, h.new_quantity::text,
                h.box_quantity, h.previous_box_quantity, h.new_box_quantity,
                h.reason, u.username AS created_by
           FROM stock_histories h
           JOIN transaction_types t ON t.id = h.transaction_type_id
           LEFT JOIN users u ON u.id = h.created_by_id
          WHERE h.item_id = $1
          ORDER BY h.created_at DESC, h.id DESC
          LIMIT ${size} OFFSET ${(page - 1) * size}`,
        [itemId],
      ),
    );

    return {
      items,
      total: Number(counted?.count ?? '0'),
      page,
      pageSize: size,
    };
  }
}
