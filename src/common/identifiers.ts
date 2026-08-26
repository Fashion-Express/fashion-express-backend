import { randomBytes } from 'node:crypto';
import type { EntityManager } from 'typeorm';
import { firstRow } from './sql';
import { lockRow } from './transaction';

/**
 * RD-01 — the six human-facing identifier formats. All are globally unique and
 * immutable once assigned (BR-45).
 *
 * DB_DESIGN.MD §7 splits them into two mechanisms:
 *
 *  - **Random suffix** (receipts, batches, employee IDs) need no coordination;
 *    uniqueness comes from the random component and the UNIQUE constraint
 *    catches the astronomically unlikely collision.
 *  - **Counters** (customers, sales) draw from a singleton row under
 *    `SELECT … FOR UPDATE`, deliberately *not* a PostgreSQL sequence: a
 *    rolled-back transaction must roll the number back too. Gapless invoice
 *    numbering is the point — a missing invoice number invites the question of
 *    what was deleted (BR-46).
 */

/** NFR-05 — the date in an identifier is the Asia/Dhaka date, not UTC. */
const DHAKA = 'Asia/Dhaka';

function dhakaParts(now: Date = new Date()): {
  dd: string;
  mm: string;
  yyyy: string;
  hh: string;
  mi: string;
  ss: string;
} {
  const fmt = new Intl.DateTimeFormat('en-GB', {
    timeZone: DHAKA,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });
  const parts = Object.fromEntries(
    fmt.formatToParts(now).map((p) => [p.type, p.value]),
  );
  return {
    dd: parts.day,
    mm: parts.month,
    yyyy: parts.year,
    hh: parts.hour === '24' ? '00' : parts.hour,
    mi: parts.minute,
    ss: parts.second,
  };
}

/** Uppercase hex, the form every RD-01 example uses (`A1B2C3`). */
function randomSuffix(bytes: number): string {
  return randomBytes(bytes).toString('hex').toUpperCase();
}

// ---------------------------------------------------------------------------
// Random-suffix identifiers (§7.1)
// ---------------------------------------------------------------------------

/** `RCPT-20260819-A1B2C3` — one per sale payment. */
export function saleReceiptNumber(now?: Date): string {
  const { yyyy, mm, dd } = dhakaParts(now);
  return `RCPT-${yyyy}${mm}${dd}-${randomSuffix(3)}`;
}

/** `SPAY-20260819-A1B2C3` — one per supplier payment. */
export function supplierPaymentNumber(now?: Date): string {
  const { yyyy, mm, dd } = dhakaParts(now);
  return `SPAY-${yyyy}${mm}${dd}-${randomSuffix(3)}`;
}

/** `CUSTPMT-20260819103045-A1B2C3` — one per customer payment event. */
export function customerPaymentBatchRef(now?: Date): string {
  const { yyyy, mm, dd, hh, mi, ss } = dhakaParts(now);
  return `CUSTPMT-${yyyy}${mm}${dd}${hh}${mi}${ss}-${randomSuffix(3)}`;
}

/** `EMP-A1B2C3D4` — one per staff account. */
export function employeeId(): string {
  return `EMP-${randomSuffix(4)}`;
}

// ---------------------------------------------------------------------------
// Counter identifiers (§7.2)
// ---------------------------------------------------------------------------

/**
 * `FE19082026-01` — creation date `DDMMYYYY` then a continuous serial.
 *
 * The serial never resets (BR-46): the date is when the record was made, and
 * the serial is independent of it. Must be called inside the same transaction
 * that inserts the customer, so a rollback returns the number.
 */
export async function nextCustomerId(
  manager: EntityManager,
  now?: Date,
): Promise<string> {
  const { dd, mm, yyyy } = dhakaParts(now);
  const serial = await bumpCounter(
    manager,
    'customer_id_sequences',
    'last_serial',
  );
  return `FE${dd}${mm}${yyyy}-${String(serial).padStart(2, '0')}`;
}

/**
 * `19-08-2026-FE-0001` — creation date `DD-MM-YYYY` then a continuous global
 * serial. One series for the whole business, not one per shop (BR-46, §18).
 */
export async function nextSaleNumber(
  manager: EntityManager,
  now?: Date,
): Promise<string> {
  const { dd, mm, yyyy } = dhakaParts(now);
  const serial = await bumpCounter(
    manager,
    'sale_id_sequences',
    'sequence_num',
  );
  return `${dd}-${mm}-${yyyy}-FE-${String(serial).padStart(4, '0')}`;
}

/**
 * Lock the singleton counter row, increment it, return the new value.
 *
 * The `CHECK (id = 1)` on both sequence tables is what makes "the singleton
 * row" a fact rather than a convention (§6).
 */
async function bumpCounter(
  manager: EntityManager,
  table: string,
  column: string,
): Promise<number> {
  // Lock first so two concurrent creations serialise here rather than racing.
  await lockRow(manager, table, 1);

  // `firstRow` because TypeORM returns [rows, count] for an UPDATE — see
  // common/sql.ts. Read naively, this silently yields `undefined` and every
  // identifier becomes "…-NaN".
  const row = firstRow<Record<string, string>>(
    await manager.query(
      `UPDATE ${table} SET ${column} = ${column} + 1 WHERE id = 1 RETURNING ${column}`,
    ),
  );
  if (!row) {
    throw new Error(
      `Counter row ${table}.id = 1 is missing — the seed migration did not run.`,
    );
  }
  return Number(row[column]);
}
