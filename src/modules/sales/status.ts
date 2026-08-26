import { BadRequestException } from '@nestjs/common';
import type { EntityManager } from 'typeorm';
import { firstRow } from '../../common/sql';

/**
 * RD-03 — the four sale states. These codes are load-bearing (BR-59): the
 * `sale_finalized_has_timestamp` constraint, the `idx_sale_fifo` partial index
 * and every revenue total read them from the row itself.
 */
export type SaleStatusCode = 'quote' | 'draft' | 'finalized' | 'cancelled';

export interface StatusPair {
  id: string;
  code: SaleStatusCode;
}

/**
 * Resolve a sale status to the **pair** the row must carry.
 *
 * `sales` stores `status_id` and a denormalised `status_code`, held together by
 * one composite foreign key onto `statuses(id, scope, code)` (BR-63). Setting
 * them independently is how they drift, so nothing outside this helper is
 * allowed to: it takes a code and returns both, and the database rejects the
 * row if they ever disagree.
 */
export async function saleStatus(
  manager: EntityManager,
  code: SaleStatusCode,
): Promise<StatusPair> {
  const row = firstRow<{ id: string }>(
    await manager.query(
      `SELECT id::text FROM statuses WHERE scope = 'sale' AND code = $1`,
      [code],
    ),
  );
  if (!row) throw new BadRequestException(`Unknown sale status "${code}".`);
  return { id: row.id, code };
}

/** The two line kinds (FR-12.8.2), resolved the same way and for the same reason. */
export type ItemTypeCode = 'inventory' | 'non_inventory';

export async function itemType(
  manager: EntityManager,
  code: ItemTypeCode,
): Promise<{ id: string; code: ItemTypeCode }> {
  const row = firstRow<{ id: string }>(
    await manager.query(`SELECT id::text FROM item_types WHERE code = $1`, [
      code,
    ]),
  );
  if (!row) throw new BadRequestException(`Unknown item type "${code}".`);
  return { id: row.id, code };
}
