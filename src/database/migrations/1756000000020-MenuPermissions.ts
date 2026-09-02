import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * FR-00.2 mechanism 2 — every navigation entry gets a menu permission of its
 * own.
 *
 * Seven sidebar entries were gated on a **record** permission instead: My bills
 * and Review bills on `view_my_bills` / `review_bills`, Users on `view_user`,
 * and the four administration screens on `manage_referencedata`. That conflated
 * two different questions — *may you open this record* and *is this in your
 * sidebar* — so the only way to take Departments out of someone's menu was to
 * stop them managing reference data at all, which also silently removed Product
 * categories and Job positions. Reports carried the same fault in a smaller
 * way, gated on `view_ledger` alongside its own menu permission.
 *
 * The two mechanisms are now separate everywhere: a menu permission decides
 * what appears in the sidebar and nothing else. **It is not an access gate.**
 * Every page keeps the guard it already had — Users still requires `view_user`,
 * the reference screens still require `manage_referencedata` — so removing a
 * menu permission hides a link without revoking anything, and cannot be used to
 * lock someone out of a URL they already hold.
 *
 * Dashboard and Settings stay ungated deliberately. They depend on no
 * permission at all rather than on the wrong one, so they were never part of
 * the problem: `/login` redirects to `/dashboard`, and a bills-only account's
 * reduced dashboard (FR-01.7) is the whole of its application.
 *
 * **The grants below reproduce exactly who sees what today**, so this migration
 * changes no one's sidebar the day it runs. Only what happens afterwards
 * changes: the menu is now editable on its own.
 */
export class MenuPermissions1756000000020 implements MigrationInterface {
  name = 'MenuPermissions1756000000020';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      INSERT INTO permissions (codename, label, module) VALUES
        ('view_bills_menu',         'Open the my bills menu',           'menu'),
        ('view_review_bills_menu',  'Open the review bills menu',       'menu'),
        ('view_users_menu',         'Open the staff accounts menu',     'menu'),
        ('view_categories_menu',    'Open the product categories menu', 'menu'),
        ('view_job_positions_menu', 'Open the job positions menu',      'menu'),
        ('view_departments_menu',   'Open the departments menu',        'menu'),
        ('view_roles_menu',         'Open the roles and permissions menu', 'menu')
    `);

    /*
     * Who sees each entry today, reproduced exactly:
     *
     *  - My bills is visible to everyone holding `view_my_bills` — all four.
     *  - Review bills, Users and the three reference screens are visible to
     *    the two roles holding `review_bills` / `view_user` /
     *    `manage_referencedata`, which is owner and manager.
     *  - Roles & permissions is administrator-only, so only owner. It is not
     *    granted to manager even though manager holds everything else here:
     *    a permission nobody can act on is a permission that lies.
     */
    const grants: Record<string, string[]> = {
      owner: [
        'view_bills_menu',
        'view_review_bills_menu',
        'view_users_menu',
        'view_categories_menu',
        'view_job_positions_menu',
        'view_departments_menu',
        'view_roles_menu',
      ],
      manager: [
        'view_bills_menu',
        'view_review_bills_menu',
        'view_users_menu',
        'view_categories_menu',
        'view_job_positions_menu',
        'view_departments_menu',
      ],
      finance: ['view_bills_menu'],
      employee: ['view_bills_menu'],
    };

    for (const [typeCode, codenames] of Object.entries(grants)) {
      await queryRunner.query(
        `INSERT INTO user_type_permissions (user_type_id, permission_id)
           SELECT t.id, p.id
             FROM user_types t, permissions p
            WHERE t.code = $1 AND p.codename = ANY($2)
         ON CONFLICT DO NOTHING`,
        [typeCode, codenames],
      );
    }

    /*
     * Finance holds `view_reports_menu` from the original seed but has never
     * seen Reports: the entry is manager-only, and the page itself is
     * manager-only (FR-09.5). Now that the menu permission is the whole of the
     * menu decision, leaving it granted would be a grant that does nothing —
     * and the next person to read the matrix would reasonably expect Finance to
     * have Reports in their sidebar.
     */
    await queryRunner.query(`
      DELETE FROM user_type_permissions utp
        USING user_types t, permissions p
       WHERE utp.user_type_id = t.id
         AND utp.permission_id = p.id
         AND t.code = 'finance'
         AND p.codename = 'view_reports_menu'
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      INSERT INTO user_type_permissions (user_type_id, permission_id)
        SELECT t.id, p.id FROM user_types t, permissions p
         WHERE t.code = 'finance' AND p.codename = 'view_reports_menu'
      ON CONFLICT DO NOTHING
    `);
    // The grants go with the rows, by ON DELETE CASCADE.
    await queryRunner.query(`
      DELETE FROM permissions WHERE codename IN (
        'view_bills_menu', 'view_review_bills_menu', 'view_users_menu',
        'view_categories_menu', 'view_job_positions_menu',
        'view_departments_menu', 'view_roles_menu')
    `);
  }
}
