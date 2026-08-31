import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * A supplier's phone number and email address become unique, matching what
 * migration 018 did for customers.
 *
 * The same reasoning applies and the same shape follows — partial so a blank
 * email is not a duplicate of a blank email, `btrim` so trailing space cannot
 * smuggle one through, `lower` on email because case does not make a second
 * mailbox. See 018 for why each of those is load-bearing.
 *
 * One difference: there is no per-shop question to answer here. Suppliers are
 * not shop-scoped at all (FR-11.4) — buying is done centrally for the business
 * — so a supplier's number is unique across the business by construction.
 */
export class SupplierContactUnique1756000000019 implements MigrationInterface {
  name = 'SupplierContactUnique1756000000019';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // As in 018: name every value that has to be merged, not just the first one
    // CREATE UNIQUE INDEX happens to trip over.
    await queryRunner.query(`
      DO $$
      DECLARE
        offenders text;
      BEGIN
        SELECT string_agg(format('%s %L (%s suppliers)', field, value, n), ', ')
          INTO offenders
          FROM (
            SELECT 'phone' AS field, btrim(phone) AS value, count(*) AS n
              FROM suppliers WHERE btrim(phone) <> ''
             GROUP BY btrim(phone) HAVING count(*) > 1
             UNION ALL
            SELECT 'email', lower(btrim(email)), count(*)
              FROM suppliers WHERE btrim(email) <> ''
             GROUP BY lower(btrim(email)) HAVING count(*) > 1
          ) d;

        IF offenders IS NOT NULL THEN
          RAISE EXCEPTION
            'Cannot make supplier phone and email unique — these values are already shared: %. Merge or correct those suppliers, then run the migration again.',
            offenders;
        END IF;
      END $$;
    `);

    await queryRunner.query(`
      CREATE UNIQUE INDEX uq_suppliers_phone
        ON suppliers (btrim(phone)) WHERE btrim(phone) <> ''
    `);

    await queryRunner.query(`
      CREATE UNIQUE INDEX uq_suppliers_email_ci
        ON suppliers (lower(btrim(email))) WHERE btrim(email) <> ''
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS uq_suppliers_email_ci`);
    await queryRunner.query(`DROP INDEX IF EXISTS uq_suppliers_phone`);
  }
}
