/**
 * Normalising what `query()` hands back.
 *
 * TypeORM's raw `query()` returns two different shapes depending on the
 * statement, and the difference is silent:
 *
 *   SELECT … RETURNING nothing   ->  rows                 e.g. [{ id: '1' }]
 *   INSERT / UPDATE / DELETE     ->  [rows, affectedRows] e.g. [[{ id: '1' }], 1]
 *
 * Reading a DML result as if it were rows does not throw — `result[0]` is the
 * rows *array*, so `result[0].id` is simply `undefined`, and `result.length` is
 * always 2 so an emptiness check never fires. That turns a missing-row 404 into
 * a silent success and an `INSERT … RETURNING id` into `undefined`.
 *
 * These helpers accept either shape, so call sites do not have to remember
 * which statement produces which.
 */

function isDmlResult(result: unknown): result is [unknown[], number] {
  return (
    Array.isArray(result) &&
    result.length === 2 &&
    Array.isArray(result[0]) &&
    typeof result[1] === 'number'
  );
}

/** The rows a statement returned, whichever shape they arrived in. */
export function rowsOf<T = Record<string, unknown>>(result: unknown): T[] {
  if (isDmlResult(result)) return result[0] as T[];
  return (Array.isArray(result) ? result : []) as T[];
}

/** The first row, or `undefined` when nothing matched. */
export function firstRow<T = Record<string, unknown>>(
  result: unknown,
): T | undefined {
  return rowsOf<T>(result)[0];
}

/**
 * How many rows a statement changed.
 *
 * For a `RETURNING` statement this is the row count PostgreSQL reported; for a
 * plain SELECT it is the number of rows read.
 */
export function affectedRows(result: unknown): number {
  if (isDmlResult(result)) return result[1];
  return Array.isArray(result) ? result.length : 0;
}
