import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * FR-02.7 / BR-67..BR-69 — a one-time, sale-level discount.
 *
 * A discount is **not a payment**. Payments are many and cumulative (BR-09);
 * a discount is a single fixed amount that reduces what is owed, moves no cash,
 * and posts nothing to the ledger. Modelling it as a negative payment would
 * have been cheaper here and wrong everywhere else: it would earn a receipt
 * number, appear in the customer's payment history, and count as money received
 * in FR-09's trading figures.
 *
 * `sales.total_amount` keeps its meaning — **the amount payable** — and the
 * discount is folded into it by the rollup:
 *
 *     total_amount = SUM(sale_items.line_total) - discount_amount
 *
 * That choice is what makes this migration small. Every existing reader of
 * `total_amount` stays correct without being touched — FR-09's `invoiced` and
 * `outstanding`, the statement's `balance_due`, the FR-03.5 FIFO allocator, and
 * the console's every total — because a discounted sale genuinely *was* invoiced
 * for less. The line subtotal is recoverable at read time as
 * `total_amount + discount_amount`, so no second stored column is needed.
 *
 * Two of the three new rules then need no new constraint at all, because
 * folding the discount into `total_amount` puts it inside the reach of checks
 * that already exist on this table (§16's division of labour — constraints for
 * correctness, service checks for the message):
 *
 *   BR-68, upper bound   sale_totals_non_negative  (total_amount >= 0)
 *   BR-68, lower bound   sale_not_overpaid         (amount_paid <= total_amount)
 *
 * A discount larger than the subtotal drives the total negative; one that
 * undercuts what has already been paid trips the overpayment check that BR-09
 * put there for payments. The same constraint now guards both directions of the
 * same invariant, which is the point of having kept the rollup honest.
 */
export class SaleDiscount1756000000021 implements MigrationInterface {
  name = 'SaleDiscount1756000000021';

  public async up(queryRunner: QueryRunner): Promise<void> {
    /**
     * `DEFAULT 0` is what makes this safe to apply to a live table: every
     * existing sale keeps exactly the `total_amount` it has today, and the
     * amended rollup below computes the same number for it as the old one did.
     *
     * The audit trio mirrors `finalized_by_id` / `finalized_at` deliberately —
     * money leaving the business should be traceable to a person by the same
     * device that already traces stock leaving it.
     */
    await queryRunner.query(`
      ALTER TABLE sales
        ADD COLUMN discount_amount  numeric(14,2) NOT NULL DEFAULT 0,
        ADD COLUMN discount_reason  text          NULL,
        ADD COLUMN discounted_by_id bigint        NULL
          REFERENCES users(id) ON DELETE SET NULL,
        ADD COLUMN discounted_at    timestamptz   NULL,

        ADD CONSTRAINT sale_discount_non_negative          -- BR-67
          CHECK (discount_amount >= 0),

        -- BR-67, the same biconditional device as sale_finalized_has_timestamp:
        -- a discount that records no author is not a discount anyone can answer
        -- for, and an author with no discount is a leftover from clearing one.
        ADD CONSTRAINT sale_discount_has_author
          CHECK ((discount_amount > 0) = (discounted_at IS NOT NULL))
    `);

    await queryRunner.query(
      `CREATE INDEX idx_sales_discounted_by ON sales (discounted_by_id)`,
    );

    /**
     * The rollup, amended. Identical to migration 014's except for the
     * subtraction — and for a sale with no discount it returns the same value,
     * which is why no backfill is needed.
     */
    await queryRunner.query(`
      CREATE OR REPLACE FUNCTION fe_refresh_sale(p_sale_id bigint) RETURNS void
      LANGUAGE sql AS $$
          UPDATE sales s SET
              total_amount = COALESCE(
                  (SELECT SUM(i.line_total) FROM sale_items i WHERE i.sale_id = s.id), 0)
                  - s.discount_amount,
              amount_paid  = COALESCE(
                  (SELECT SUM(p.amount) FROM sale_payments p WHERE p.sale_id = s.id), 0)
          WHERE s.id = p_sale_id;
      $$;
    `);

    /**
     * The gap that redefining `fe_refresh_sale` alone would leave.
     *
     * Migration 014's triggers fire on `sale_items` and `sale_payments` only, so
     * they recompute the total whenever a *line* or a *payment* changes. Nothing
     * fires when the discount itself changes: an `UPDATE sales SET
     * discount_amount = …` would store the new discount and leave `total_amount`
     * at its old value, and the CHECK constraints this design leans on would
     * then be measuring a stale number — the failure would be silent and the
     * data wrong, which is exactly what §11 moved these caches into the database
     * to prevent.
     *
     * A BEFORE trigger closes it. It cannot recurse: a BEFORE row trigger
     * assigns to NEW and issues no statement of its own, so it can never
     * re-enter the AFTER rollup triggers, and those in turn only ever reach here
     * through the WHEN guard below.
     *
     * The WHEN clause is load-bearing rather than an optimisation.
     * `fe_refresh_sale` issues `UPDATE sales` on every line and payment change,
     * so without the guard this would run on all of them — harmlessly, since it
     * computes the same value, but it would re-scan `sale_items` a second time
     * for every payment ever recorded.
     *
     * `sales` already carries `trg_sales_touch` (migration 016) as a BEFORE
     * UPDATE trigger. The two coexist: PostgreSQL fires BEFORE row triggers in
     * name order, and these two assign to different columns, so the order does
     * not matter.
     */
    await queryRunner.query(`
      CREATE OR REPLACE FUNCTION fe_sale_discount_changed() RETURNS trigger
      LANGUAGE plpgsql AS $$
      BEGIN
          NEW.total_amount := COALESCE(
              (SELECT SUM(i.line_total) FROM sale_items i WHERE i.sale_id = NEW.id), 0)
              - NEW.discount_amount;
          RETURN NEW;
      END;
      $$;
    `);

    await queryRunner.query(`
      CREATE TRIGGER trg_sale_discount
          BEFORE UPDATE ON sales
          FOR EACH ROW
          WHEN (OLD.discount_amount IS DISTINCT FROM NEW.discount_amount)
          EXECUTE FUNCTION fe_sale_discount_changed();
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP TRIGGER IF EXISTS trg_sale_discount ON sales`,
    );
    await queryRunner.query(
      `DROP FUNCTION IF EXISTS fe_sale_discount_changed()`,
    );

    // Migration 014's original, restored verbatim.
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

    await queryRunner.query(`DROP INDEX IF EXISTS idx_sales_discounted_by`);

    /*
     * Dropping the column restores every total to the undiscounted subtotal,
     * which is the only consistent state once the discount is gone — a sale
     * cannot keep a reduction whose amount no longer exists anywhere.
     */
    await queryRunner.query(`
      ALTER TABLE sales
        DROP CONSTRAINT IF EXISTS sale_discount_has_author,
        DROP CONSTRAINT IF EXISTS sale_discount_non_negative,
        DROP COLUMN IF EXISTS discounted_at,
        DROP COLUMN IF EXISTS discounted_by_id,
        DROP COLUMN IF EXISTS discount_reason,
        DROP COLUMN IF EXISTS discount_amount
    `);

    await queryRunner.query(`
      UPDATE sales s SET total_amount = COALESCE(
          (SELECT SUM(i.line_total) FROM sale_items i WHERE i.sale_id = s.id), 0)
    `);
  }
}
