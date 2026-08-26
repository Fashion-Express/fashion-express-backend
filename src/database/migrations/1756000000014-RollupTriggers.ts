import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * DB_DESIGN.MD §11 — the derived columns, and how they are kept true.
 *
 * Three columns are caches of an aggregate over child rows:
 *
 *   sales.total_amount              SUM(line_total) over the sale's items
 *   sales.amount_paid               SUM(amount) over the sale's payments
 *   supplier_purchases.paid_amount  SUM(amount) over the purchase's payments
 *
 * (`sale_items.line_total` is the fourth, and it is a stored generated column
 * in migration 010 rather than a trigger — §11 note 4.)
 *
 * Maintaining these in application code works for every path the application
 * controls and fails for every path it does not: a bulk update, a data
 * migration, a fix applied in psql. Moving the maintenance into triggers makes
 * the caches true unconditionally — and that is precisely what allows the
 * overpayment rules BR-09 and BR-30 to exist as real CHECK constraints rather
 * than hopes.
 *
 * **Application code need not compute these at all.** Whatever the service
 * layer writes, the triggers overwrite with the correct value, so totals cannot
 * drift because a code path forgot to recalculate.
 */
export class RollupTriggers1756000000014 implements MigrationInterface {
  name = 'RollupTriggers1756000000014';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // ---- sale rollups --------------------------------------------------
    await queryRunner.query(`
      CREATE OR REPLACE FUNCTION fe_refresh_sale(p_sale_id bigint) RETURNS void
      LANGUAGE sql AS $$
          UPDATE sales s SET
              total_amount = COALESCE(
                  (SELECT SUM(i.line_total) FROM sale_items i WHERE i.sale_id = s.id), 0),
              amount_paid  = COALESCE(
                  (SELECT SUM(p.amount) FROM sale_payments p WHERE p.sale_id = s.id), 0)
          WHERE s.id = p_sale_id;
      $$;
    `);

    /**
     * Both OLD and NEW are handled. If a line item is ever reassigned to a
     * different sale, both the old and the new sale need recomputing — a naive
     * trigger using only NEW would leave the old sale's total permanently
     * wrong.
     *
     * Cascade deletes are safe: PostgreSQL removes the parent sale first, then
     * the cascade removes its children and fires this. The UPDATE then matches
     * zero rows and does nothing. Harmless, not a bug.
     */
    await queryRunner.query(`
      CREATE OR REPLACE FUNCTION fe_sale_child_changed() RETURNS trigger
      LANGUAGE plpgsql AS $$
      BEGIN
          IF TG_OP <> 'INSERT' THEN PERFORM fe_refresh_sale(OLD.sale_id); END IF;
          IF TG_OP <> 'DELETE' THEN PERFORM fe_refresh_sale(NEW.sale_id); END IF;
          RETURN NULL;
      END;
      $$;
    `);

    await queryRunner.query(`
      CREATE TRIGGER trg_saleitem_rollup
          AFTER INSERT OR UPDATE OR DELETE ON sale_items
          FOR EACH ROW EXECUTE FUNCTION fe_sale_child_changed();
    `);
    await queryRunner.query(`
      CREATE TRIGGER trg_salepayment_rollup
          AFTER INSERT OR UPDATE OR DELETE ON sale_payments
          FOR EACH ROW EXECUTE FUNCTION fe_sale_child_changed();
    `);

    // ---- supplier purchase rollup --------------------------------------
    await queryRunner.query(`
      CREATE OR REPLACE FUNCTION fe_refresh_purchase(p_purchase_id bigint) RETURNS void
      LANGUAGE sql AS $$
          UPDATE supplier_purchases p SET
              paid_amount = COALESCE(
                  (SELECT SUM(x.amount) FROM supplier_purchase_payments x
                    WHERE x.purchase_id = p.id), 0)
          WHERE p.id = p_purchase_id;
      $$;
    `);

    await queryRunner.query(`
      CREATE OR REPLACE FUNCTION fe_purchase_payment_changed() RETURNS trigger
      LANGUAGE plpgsql AS $$
      BEGIN
          IF TG_OP <> 'INSERT' THEN PERFORM fe_refresh_purchase(OLD.purchase_id); END IF;
          IF TG_OP <> 'DELETE' THEN PERFORM fe_refresh_purchase(NEW.purchase_id); END IF;
          RETURN NULL;
      END;
      $$;
    `);

    await queryRunner.query(`
      CREATE TRIGGER trg_supplierpayment_rollup
          AFTER INSERT OR UPDATE OR DELETE ON supplier_purchase_payments
          FOR EACH ROW EXECUTE FUNCTION fe_purchase_payment_changed();
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP TRIGGER IF EXISTS trg_supplierpayment_rollup ON supplier_purchase_payments`,
    );
    await queryRunner.query(
      `DROP TRIGGER IF EXISTS trg_salepayment_rollup ON sale_payments`,
    );
    await queryRunner.query(
      `DROP TRIGGER IF EXISTS trg_saleitem_rollup ON sale_items`,
    );
    await queryRunner.query(
      `DROP FUNCTION IF EXISTS fe_purchase_payment_changed()`,
    );
    await queryRunner.query(
      `DROP FUNCTION IF EXISTS fe_refresh_purchase(bigint)`,
    );
    await queryRunner.query(`DROP FUNCTION IF EXISTS fe_sale_child_changed()`);
    await queryRunner.query(`DROP FUNCTION IF EXISTS fe_refresh_sale(bigint)`);
  }
}
