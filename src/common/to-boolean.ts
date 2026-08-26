import { Transform } from 'class-transformer';

/**
 * Parse a boolean from a query string.
 *
 * **Do not use `@Type(() => Boolean)` for this.** It calls the `Boolean`
 * constructor, and `Boolean("false")` is `true` — as is `Boolean("0")`. Every
 * non-empty string is truthy, so `?isActive=false` silently means *true* and a
 * filter appears to work while doing the opposite of what was asked. That is a
 * wrong answer rather than an error, which makes it the worst kind of bug: it
 * was found here only because `?preview=false` on the ledger rebuild reported
 * writing rows it had not written.
 *
 * Anything unrecognised is passed through untouched so `@IsBoolean()` rejects
 * it with a 400. Guessing at `?isActive=maybe` would be the same mistake again.
 */
export const ToBoolean = (): PropertyDecorator =>
  Transform(({ value }: { value: unknown }) => {
    if (typeof value === 'boolean') return value;
    if (typeof value === 'string') {
      const normalised = value.trim().toLowerCase();
      if (['true', '1', 'yes', 'on'].includes(normalised)) return true;
      if (['false', '0', 'no', 'off'].includes(normalised)) return false;
    }
    return value;
  });
