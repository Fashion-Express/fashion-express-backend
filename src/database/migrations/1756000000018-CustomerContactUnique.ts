import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * A customer's phone number and email address become unique.
 *
 * **This reverses a decision recorded in DB_DESIGN.MD §4**, which listed both
 * columns as deliberately not unique on the grounds that two branches of one
 * company often share a phone number. In practice the same person was being
 * entered twice and turning up as two customers with two balances, and the
 * business asked for the duplicate to be refused. §4 has been updated to record
 * the reversal rather than left contradicting the schema.
 *
 * Three details make the pair behave:
 *
 *  - **Partial.** `email` is optional and stored as `''` when absent (§1), and
 *    older `phone` values may be blank too. A plain unique index would let
 *    exactly one customer have no email; `WHERE btrim(...) <> ''` leaves blanks
 *    unconstrained, the same shape as `uq_users_email_ci`.
 *  - **Trimmed.** Indexing `btrim(phone)` means `'017 '` cannot slip past
 *    `'017'`, which is how a duplicate would otherwise be re-entered.
 *  - **Case-insensitive on email.** `Rabby@x.com` and `rabby@x.com` are one
 *    mailbox, so the index is on `lower(btrim(email))`.
 *
 * Uniqueness is **global, not per shop.** A per-shop rule would still let the
 * same person be registered once in each branch, which is the duplicate that
 * prompted this. It follows `customer_id`, which is global for the same reason
 * (§4), rather than `part_code`, which is per shop (§5).
 *
 * Normalisation stops at trimming. Whether `+8801700000000` and `01700000000`
 * are the same subscriber is a business question, not a schema one; deciding it
 * later means a generated column and a new index, not a change to this one.
 */
export class CustomerContactUnique1756000000018 implements MigrationInterface {
  name = 'CustomerContactUnique1756000000018';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // Existing duplicates would make CREATE UNIQUE INDEX fail with a single
    // offending value and nothing else. Since this runs against live data, say
    // what has to be merged first — all of it, not the first one PostgreSQL
    // happens to hit.
    await queryRunner.query(`
      DO $$
      DECLARE
        offenders text;
      BEGIN
        SELECT string_agg(format('%s %L (%s customers)', field, value, n), ', ')
          INTO offenders
          FROM (
            SELECT 'phone' AS field, btrim(phone) AS value, count(*) AS n
              FROM customers WHERE btrim(phone) <> ''
             GROUP BY btrim(phone) HAVING count(*) > 1
             UNION ALL
            SELECT 'email', lower(btrim(email)), count(*)
              FROM customers WHERE btrim(email) <> ''
             GROUP BY lower(btrim(email)) HAVING count(*) > 1
          ) d;

        IF offenders IS NOT NULL THEN
          RAISE EXCEPTION
            'Cannot make customer phone and email unique — these values are already shared: %. Merge or correct those customers, then run the migration again.',
            offenders;
        END IF;
      END $$;
    `);

    await queryRunner.query(`
      CREATE UNIQUE INDEX uq_customers_phone
        ON customers (btrim(phone)) WHERE btrim(phone) <> ''
    `);

    await queryRunner.query(`
      CREATE UNIQUE INDEX uq_customers_email_ci
        ON customers (lower(btrim(email))) WHERE btrim(email) <> ''
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS uq_customers_email_ci`);
    await queryRunner.query(`DROP INDEX IF EXISTS uq_customers_phone`);
  }
}
