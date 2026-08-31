import { ConflictException } from '@nestjs/common';
import type { EntityManager } from 'typeorm';
import { rowsOf } from './sql';

/**
 * "One party, one phone number, one email address" — the readable half of the
 * rule that `uq_customers_*` and `uq_suppliers_*` guarantee.
 *
 * The indexes are what make the rule true; a service could skip this check and
 * still never write a duplicate. What this adds is the sentence: *who* already
 * holds the value, so the person entering it can go and edit that record
 * instead of inventing a second one. It also reports both fields at once rather
 * than one per round trip.
 *
 * Both tables carry the same three columns (`name`, `phone`, `email`) and the
 * same pair of partial indexes, so one implementation serves both — see
 * `CUSTOMER_CONTACTS` and `SUPPLIER_CONTACTS` below.
 */
export interface ContactOwner {
  /** Table to search. A constant from this file — never caller input. */
  readonly table: string;
  /** What the record is called in the message: "customer", "supplier". */
  readonly noun: string;
  /**
   * A human-facing identifier to quote alongside the name, if the table has
   * one. Customers have `customer_id` (`FE31082026-02`); suppliers have only a
   * name, and a bare name is enough to find one.
   */
  readonly reference?: string;
}

export const CUSTOMER_CONTACTS: ContactOwner = {
  table: 'customers',
  noun: 'customer',
  reference: 'customer_id',
};

export const SUPPLIER_CONTACTS: ContactOwner = {
  table: 'suppliers',
  noun: 'supplier',
};

interface Clash {
  field: 'phone' | 'email';
  name: string;
  reference: string | null;
}

/**
 * Throw if another row in `owner.table` already holds this phone or email.
 *
 * Call it inside the transaction that does the write. That narrows the race to
 * nothing the unique index does not close — and the index, not this, is what
 * closes it.
 *
 * Blank is never a duplicate of blank: email is optional and stored as `''`,
 * and the indexes are partial for the same reason.
 */
export async function assertContactsAreFree(
  manager: EntityManager,
  owner: ContactOwner,
  contact: { phone?: string; email?: string },
  excludeId?: string,
): Promise<void> {
  const phone = contact.phone?.trim() ?? '';
  const email = contact.email?.trim() ?? '';
  if (!phone && !email) return;

  const reference = owner.reference ?? 'NULL';

  // A union rather than one pass with a CASE: when a single record holds both
  // the phone and the email, one row could only be labelled with one of them,
  // and the caller would fix the phone only to be refused again.
  //
  // `btrim` and `lower` mirror the index expressions exactly. If they drift,
  // this check starts passing writes the database then refuses.
  const clashes = rowsOf<Clash>(
    await manager.query(
      `SELECT 'phone' AS field, name, ${reference} AS reference
         FROM ${owner.table}
        WHERE $1 <> '' AND btrim(phone) = $1
          AND ($3::bigint IS NULL OR id <> $3::bigint)
        UNION ALL
       SELECT 'email', name, ${reference}
         FROM ${owner.table}
        WHERE $2 <> '' AND lower(btrim(email)) = lower($2)
          AND ($3::bigint IS NULL OR id <> $3::bigint)`,
      [phone, email, excludeId ?? null],
    ),
  );
  if (clashes.length === 0) return;

  // One sentence per field, even when several rows match — naming the first is
  // enough to find the record, and listing four is not help.
  const parts: string[] = [];
  for (const field of ['phone', 'email'] as const) {
    const clash = clashes.find((c) => c.field === field);
    if (!clash) continue;
    const label = field === 'phone' ? 'phone number' : 'email address';
    const who = clash.reference
      ? `${clash.name} (${clash.reference})`
      : clash.name;
    parts.push(`That ${label} already belongs to ${who}.`);
  }

  throw new ConflictException(
    `${parts.join(' ')} Update that ${owner.noun} instead of creating a second record.`,
  );
}
