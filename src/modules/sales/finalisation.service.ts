import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, EntityManager } from 'typeorm';
import { Decimal } from '../../common/decimal';
import { firstRow, rowsOf } from '../../common/sql';
import { lockRow, TransactionService } from '../../common/transaction';
import { StockHistoryService } from '../inventory/stock-history.service';
import { SalePaymentsService } from './sale-payments.service';
import { saleStatus } from './status';

interface StockedLine {
  id: string;
  inventory_item_id: string;
  quantity: string;
  boxes: number;
  part_code: string;
  part_name: string;
  available_quantity: string;
  available_boxes: number;
  minimum_stock: number;
}

/**
 * FR-02.4 — finalising, and the two rules that make it safe.
 *
 * **BR-06** — availability is validated for *every* line before *any* deduction
 * occurs, for both loose units and whole boxes. If any line is short the entire
 * finalisation is refused and nothing is changed. Validating and deducting line
 * by line would leave a half-issued sale behind on the first shortfall.
 *
 * **BR-07** — the deductions, the movement records and the status change either
 * all succeed or all roll back. One transaction, and the biconditional
 * `sale_finalized_has_timestamp` means the status and the timestamp cannot
 * disagree even if this code tried.
 */
@Injectable()
export class FinalisationService {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly transactions: TransactionService,
    private readonly history: StockHistoryService,
    private readonly payments: SalePaymentsService,
  ) {}

  async finalise(
    saleId: string,
    actorId: string | null,
  ): Promise<{
    saleNumber: string;
    nowLowOnStock: Array<Record<string, unknown>>;
  }> {
    return this.transactions.run(async (manager) => {
      const sale = await lockRow<{
        id: string;
        sale_number: string;
        status_code: string;
      }>(manager, 'sales', saleId);
      if (!sale) throw new NotFoundException('No such sale.');

      // BR-08 — a sale that is already finalised cannot be finalised again.
      if (sale.status_code === 'finalized') {
        throw new BadRequestException(
          `${sale.sale_number} is already finalised (BR-08).`,
        );
      }
      if (sale.status_code === 'cancelled') {
        throw new BadRequestException('A cancelled sale cannot be finalised.');
      }
      if (sale.status_code === 'quote') {
        throw new BadRequestException(
          'Convert the quotation to an invoice before finalising (FR-02.3.1).',
        );
      }

      const lines = await this.stockedLines(manager, saleId);

      // BR-05 — a sale needs at least one line. An empty finalised sale would
      // also break `sale_not_overpaid` the moment anything was paid against it.
      const anyLine = firstRow<{ n: string }>(
        await manager.query(
          `SELECT count(*)::text AS n FROM sale_items WHERE sale_id = $1`,
          [saleId],
        ),
      );
      if (Number(anyLine?.n ?? '0') === 0) {
        throw new BadRequestException(
          'A sale must have at least one line item to be finalised (BR-05).',
        );
      }

      // ---- BR-06: validate everything first -------------------------
      const shortfalls: string[] = [];
      for (const line of lines) {
        if (new Decimal(line.quantity).greaterThan(line.available_quantity)) {
          shortfalls.push(
            `${line.part_name} (${line.part_code}): need ${new Decimal(line.quantity).toFixed(3)}, ` +
              `have ${new Decimal(line.available_quantity).toFixed(3)}`,
          );
        }
        if (line.boxes > line.available_boxes) {
          shortfalls.push(
            `${line.part_name} (${line.part_code}): need ${line.boxes} box(es), ` +
              `have ${line.available_boxes}`,
          );
        }
      }
      if (shortfalls.length > 0) {
        throw new BadRequestException(
          `Not enough stock to finalise ${sale.sale_number}. Nothing has been ` +
            `changed (BR-06). Short: ${shortfalls.join('; ')}.`,
        );
      }

      // ---- then deduct ----------------------------------------------
      const nowLowOnStock: Array<Record<string, unknown>> = [];

      for (const line of lines) {
        const previousQuantity = line.available_quantity;
        const nextQuantity = new Decimal(previousQuantity)
          .minus(line.quantity)
          .toFixed(3);
        const previousBoxes = line.available_boxes;
        const nextBoxes = previousBoxes - line.boxes;

        await manager.query(
          `UPDATE inventory_items SET quantity = $1, box_count = $2 WHERE id = $3`,
          [nextQuantity, nextBoxes, line.inventory_item_id],
        );

        /**
         * FR-02.4.1 — a movement is recorded against each affected product,
         * naming the sale and the user who finalised it. BR-26 keeps the unit
         * and box movements as separate rows; `record` writes only the
         * dimensions that actually moved, and marks boxes as boxes.
         */
        await this.history.record(manager, {
          itemId: line.inventory_item_id,
          type: 'out',
          reason: sale.sale_number,
          actorId,
          units: { previous: previousQuantity, next: nextQuantity },
        });
        await this.history.record(manager, {
          itemId: line.inventory_item_id,
          type: 'out',
          reason: `${sale.sale_number} (boxes)`,
          actorId,
          boxes: { previous: previousBoxes, next: nextBoxes },
        });

        // FR-02.4.2 — tell the user which items now need reordering (BR-24).
        if (new Decimal(nextQuantity).lessThanOrEqualTo(line.minimum_stock)) {
          nowLowOnStock.push({
            id: line.inventory_item_id,
            partCode: line.part_code,
            partName: line.part_name,
            quantity: nextQuantity,
            minimumStock: line.minimum_stock,
          });
        }
      }

      const status = await saleStatus(manager, 'finalized');
      await manager.query(
        `UPDATE sales
            SET status_id = $1, status_code = $2,
                finalized_at = now(), finalized_by_id = $3, updated_by_id = $3
          WHERE id = $4`,
        [status.id, status.code, actorId, saleId],
      );

      return { saleNumber: sale.sale_number, nowLowOnStock };
    });
  }

  /**
   * The stocked lines of a sale, with the product's current stock locked.
   *
   * `FOR UPDATE OF` locks only the inventory rows — two sales finalising
   * against the same product must serialise, or both could pass the
   * availability check and drive stock negative between them. `ORDER BY` the
   * item id so two finalisations touching overlapping products cannot deadlock.
   *
   * Machine lines are absent by construction: they have no `inventory_item_id`
   * and draw on no stock (BR-04).
   */
  private async stockedLines(
    manager: EntityManager,
    saleId: string,
  ): Promise<StockedLine[]> {
    return rowsOf<StockedLine>(
      await manager.query(
        `SELECT i.id::text, i.inventory_item_id::text, i.quantity::text, i.boxes,
                inv.part_code, inv.part_name,
                inv.quantity::text AS available_quantity,
                inv.box_count      AS available_boxes,
                inv.minimum_stock
           FROM sale_items i
           JOIN inventory_items inv ON inv.id = i.inventory_item_id
          WHERE i.sale_id = $1 AND i.item_type_code = 'inventory'
          ORDER BY inv.id
            FOR UPDATE OF inv`,
        [saleId],
      ),
    );
  }

  /**
   * FR-02.6.1 — add a line to an already-finalised sale.
   *
   * BR-13 — stock is validated and deducted immediately, exactly as at
   * finalisation. The line is inserted first so the same locking and checking
   * path can be reused over it.
   */
  async deductForAddedLine(
    manager: EntityManager,
    saleId: string,
    lineId: string,
    saleNumber: string,
    actorId: string | null,
  ): Promise<void> {
    const line = firstRow<StockedLine>(
      await manager.query(
        `SELECT i.id::text, i.inventory_item_id::text, i.quantity::text, i.boxes,
                inv.part_code, inv.part_name,
                inv.quantity::text AS available_quantity,
                inv.box_count      AS available_boxes,
                inv.minimum_stock
           FROM sale_items i
           JOIN inventory_items inv ON inv.id = i.inventory_item_id
          WHERE i.id = $1
            FOR UPDATE OF inv`,
        [lineId],
      ),
    );
    // A machine line draws on nothing, so there is simply nothing to deduct.
    if (!line) return;

    if (
      new Decimal(line.quantity).greaterThan(line.available_quantity) ||
      line.boxes > line.available_boxes
    ) {
      throw new BadRequestException(
        `Not enough stock of ${line.part_name} (${line.part_code}) to add this ` +
          `line. Nothing has been changed (BR-13).`,
      );
    }

    const nextQuantity = new Decimal(line.available_quantity)
      .minus(line.quantity)
      .toFixed(3);
    const nextBoxes = line.available_boxes - line.boxes;

    await manager.query(
      `UPDATE inventory_items SET quantity = $1, box_count = $2 WHERE id = $3`,
      [nextQuantity, nextBoxes, line.inventory_item_id],
    );
    await this.history.record(manager, {
      itemId: line.inventory_item_id,
      type: 'out',
      reason: `${saleNumber} (line added)`,
      actorId,
      units: { previous: line.available_quantity, next: nextQuantity },
    });
    await this.history.record(manager, {
      itemId: line.inventory_item_id,
      type: 'out',
      reason: `${saleNumber} (line added, boxes)`,
      actorId,
      boxes: { previous: line.available_boxes, next: nextBoxes },
    });
  }

  /**
   * FR-02.6.1 — remove a line from an already-finalised sale.
   *
   * BR-12 — the stock that line consumed is **returned to inventory** and a
   * reversing movement is recorded. Stock is never silently lost.
   *
   * FR-02.6.2 — if this empties the sale it reverts to draft and its payments
   * are deleted, so no orphaned overpayment remains. The ordering matters and
   * is not incidental: `sale_not_overpaid` is a plain CHECK maintained by an
   * AFTER trigger, so it fires on the statement that removes the line. The
   * payments must go *first*, or shrinking the sale below what has been paid is
   * refused outright.
   */
  async reverseRemovedLine(
    saleId: string,
    lineId: string,
    actorId: string | null,
  ): Promise<{ revertedToDraft: boolean; paymentsRemoved: number }> {
    return this.transactions.run(async (manager) => {
      const sale = await lockRow<{
        id: string;
        sale_number: string;
        status_code: string;
      }>(manager, 'sales', saleId);
      if (!sale) throw new NotFoundException('No such sale.');

      const line = firstRow<{
        id: string;
        inventory_item_id: string | null;
        quantity: string;
        boxes: number;
      }>(
        await manager.query(
          `SELECT id::text, inventory_item_id::text, quantity::text, boxes
             FROM sale_items WHERE id = $1 AND sale_id = $2`,
          [lineId, saleId],
        ),
      );
      if (!line) throw new NotFoundException('No such line on this sale.');

      const remaining = firstRow<{ n: string }>(
        await manager.query(
          `SELECT count(*)::text AS n FROM sale_items WHERE sale_id = $1 AND id <> $2`,
          [saleId, lineId],
        ),
      );
      const willBeEmpty = Number(remaining?.n ?? '0') === 0;

      let paymentsRemoved = 0;
      if (willBeEmpty && sale.status_code === 'finalized') {
        // Before the line goes — see the note above.
        paymentsRemoved = await this.payments.removeAllForSale(manager, saleId);
      }

      // BR-12 — return the stock, with a reversing movement naming the sale.
      if (line.inventory_item_id && sale.status_code === 'finalized') {
        const item = await lockRow<{ quantity: string; box_count: number }>(
          manager,
          'inventory_items',
          line.inventory_item_id,
        );
        const nextQuantity = new Decimal(item!.quantity)
          .plus(line.quantity)
          .toFixed(3);
        const nextBoxes = item!.box_count + line.boxes;

        await manager.query(
          `UPDATE inventory_items SET quantity = $1, box_count = $2 WHERE id = $3`,
          [nextQuantity, nextBoxes, line.inventory_item_id],
        );
        await this.history.record(manager, {
          itemId: line.inventory_item_id,
          type: 'adjustment',
          reason: `Reversal of ${sale.sale_number}`,
          actorId,
          units: { previous: item!.quantity, next: nextQuantity },
        });
        await this.history.record(manager, {
          itemId: line.inventory_item_id,
          type: 'adjustment',
          reason: `Reversal of ${sale.sale_number} (boxes)`,
          actorId,
          boxes: { previous: item!.box_count, next: nextBoxes },
        });
      }

      await manager.query(`DELETE FROM sale_items WHERE id = $1`, [lineId]);

      let revertedToDraft = false;
      if (willBeEmpty && sale.status_code === 'finalized') {
        const draft = await saleStatus(manager, 'draft');
        await manager.query(
          `UPDATE sales
              SET status_id = $1, status_code = $2,
                  finalized_at = NULL, finalized_by_id = NULL
            WHERE id = $3`,
          [draft.id, draft.code, saleId],
        );
        revertedToDraft = true;
      }

      return { revertedToDraft, paymentsRemoved };
    });
  }
}
