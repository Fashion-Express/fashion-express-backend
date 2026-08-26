import Decimal from 'decimal.js';
import type { ValueTransformer } from 'typeorm';

/**
 * NFR-01 — all monetary amounts are exact decimals. Floating point is
 * forbidden anywhere in the stack.
 *
 * `pg` already returns PostgreSQL `numeric` as a JavaScript *string* rather
 * than a float, which is the behaviour this relies on: the value never passes
 * through a `number`, so it can never lose precision. These transformers turn
 * that string into a `Decimal` on the way in and back into a string on the way
 * out. Nothing in the codebase should call `parseFloat`, `Number()`, or use
 * `+`/`*` on a money value — use the `Decimal` API.
 */

export { Decimal };

/** Money: `numeric(14,2)` (DB_DESIGN.MD §1). */
export const decimalTransformer: ValueTransformer = {
  to(value: Decimal | string | null | undefined): string | null {
    if (value === null || value === undefined) return null;
    return new Decimal(value).toFixed(2);
  },
  from(value: string | null): Decimal | null {
    if (value === null || value === undefined) return null;
    return new Decimal(value);
  },
};

/** Quantity: `numeric(14,3)` — three decimals for part units (FR-04.2, NFR-02). */
export const quantityTransformer: ValueTransformer = {
  to(value: Decimal | string | null | undefined): string | null {
    if (value === null || value === undefined) return null;
    return new Decimal(value).toFixed(3);
  },
  from(value: string | null): Decimal | null {
    if (value === null || value === undefined) return null;
    return new Decimal(value);
  },
};

export const ZERO = new Decimal(0);

/** Sum a list of money values without ever leaving decimal arithmetic. */
export function sum(values: Array<Decimal | string>): Decimal {
  return values.reduce<Decimal>((acc, v) => acc.plus(new Decimal(v)), ZERO);
}

/** Round to money scale (2dp), matching what the database will store. */
export function toMoney(value: Decimal | string | number): Decimal {
  return new Decimal(value).toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
}

/** Round to quantity scale (3dp), matching `numeric(14,3)`. */
export function toQuantity(value: Decimal | string | number): Decimal {
  return new Decimal(value).toDecimalPlaces(3, Decimal.ROUND_HALF_UP);
}
