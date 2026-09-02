import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import ExcelJS from 'exceljs';
import { DataSource } from 'typeorm';
import { firstRow, rowsOf } from '../../common/sql';

/**
 * FR-09 — reports and exports. Manager-only (FR-09.5).
 *
 * Two things run through every export here:
 *
 *  - **Money is written as a number with a display format, not as a string.**
 *    A spreadsheet cell holding `"1500.00"` is text: it will not sum, and a
 *    grand-total row over it silently reads zero. The value is converted at the
 *    boundary and nowhere earlier, so NFR-01's exactness holds right up to the
 *    point where the format demands a float.
 *  - **Labels, never ids.** §23.6 is explicit: an export selecting foreign keys
 *    fills the sheet with integers nobody can read.
 */
@Injectable()
export class ReportsService {
  constructor(@InjectDataSource() private readonly dataSource: DataSource) {}

  /** FR-09.2 — the current balance, carried through from the ledger. */
  async summary(): Promise<Record<string, unknown>> {
    const balance = firstRow<Record<string, string>>(
      await this.dataSource.query(
        `SELECT COALESCE(SUM(e.amount * t.direction), 0)::text AS balance,
                COALESCE(SUM(e.amount) FILTER (WHERE t.direction = 1), 0)::text AS credits,
                COALESCE(SUM(e.amount) FILTER (WHERE t.direction = -1), 0)::text AS debits
           FROM ledger_entries e JOIN ledger_entry_types t ON t.id = e.entry_type_id`,
      ),
    )!;

    const trading = firstRow<Record<string, string>>(
      await this.dataSource.query(
        `SELECT COALESCE(SUM(total_amount), 0)::text AS invoiced,
                COALESCE(SUM(amount_paid), 0)::text  AS received,
                COALESCE(SUM(total_amount - amount_paid), 0)::text AS outstanding
           FROM sales WHERE status_code = 'finalized'`,
      ),
    )!;

    return { ledger: balance, trading, byShop: await this.byShop() };
  }

  /**
   * FR-09.6 — reports break down by shop.
   *
   * Revenue is shop-scoped, so this works. **Net profit is not available**:
   * expenses carry an optional shop and many are business-wide by design
   * (§10.2), so subtracting them per shop would be arbitrary. Gross figures are
   * what the data supports, and the response says so rather than inventing a
   * number.
   */
  private async byShop(): Promise<Array<Record<string, unknown>>> {
    return rowsOf(
      await this.dataSource.query(
        `SELECT sh.id::text, sh.name, sh.is_active,
                COALESCE(s.invoiced, 0)::text     AS invoiced,
                COALESCE(s.received, 0)::text     AS received,
                COALESCE(s.outstanding, 0)::text  AS outstanding,
                COALESCE(s.sale_count, 0)::text   AS sale_count,
                COALESCE(inv.stock_value, 0)::text AS stock_value,
                COALESCE(c.customer_count, 0)::text AS customer_count,
                -- Only the expenses explicitly attributed to this shop; the
                -- business-wide ones are deliberately excluded.
                COALESCE(e.attributed_expenses, 0)::text AS attributed_expenses
           FROM shops sh
           LEFT JOIN LATERAL (
             SELECT SUM(total_amount) AS invoiced, SUM(amount_paid) AS received,
                    SUM(total_amount - amount_paid) AS outstanding, count(*) AS sale_count
               FROM sales WHERE shop_id = sh.id AND status_code = 'finalized') s ON true
           LEFT JOIN LATERAL (
             SELECT round(SUM(quantity * unit_price), 2) AS stock_value
               FROM inventory_items WHERE shop_id = sh.id) inv ON true
           LEFT JOIN LATERAL (
             SELECT count(*) AS customer_count FROM customers WHERE shop_id = sh.id) c ON true
           LEFT JOIN LATERAL (
             SELECT SUM(amount) AS attributed_expenses
               FROM expenses WHERE shop_id = sh.id) e ON true
          ORDER BY sh.name`,
      ),
    );
  }

  /**
   * FR-09.3 — the full data export: one sheet each for employees, customers,
   * inventory, expenses and payments.
   */
  async fullExport(): Promise<ExcelJS.Buffer> {
    const workbook = this.newWorkbook();

    this.addSheet(
      workbook,
      'Employees',
      [
        'Employee ID',
        'Username',
        'Name',
        'Type',
        'Status',
        'Phone',
        'Join date',
        'Shop',
      ],
      rowsOf(
        await this.dataSource.query(
          `SELECT u.employee_id, u.username, u.name, t.label AS type,
                  st.label AS status, u.phone, u.join_date::text, sh.name AS shop
             FROM users u
             JOIN user_types t ON t.id = u.user_type_id
             JOIN statuses st ON st.id = u.status_id AND st.scope = 'user'
             LEFT JOIN shops sh ON sh.id = u.shop_id
            ORDER BY u.username`,
        ),
      ),
    );

    // FR-09.6 — shop is a column in the customer export.
    this.addSheet(
      workbook,
      'Customers',
      [
        'Customer ID',
        'Name',
        'Company',
        'Phone',
        'Email',
        'City',
        'Status',
        'Shop',
      ],
      rowsOf(
        await this.dataSource.query(
          `SELECT c.customer_id, c.name, c.company, c.phone, c.email, c.city,
                  st.label AS status, sh.name AS shop
             FROM customers c
             JOIN statuses st ON st.id = c.status_id AND st.scope = 'customer'
             JOIN shops sh ON sh.id = c.shop_id
            ORDER BY c.customer_id`,
        ),
      ),
    );

    this.addSheet(
      workbook,
      'Inventory',
      [
        'Code',
        'Name',
        'Shop',
        'Category',
        'Unit',
        'Supplier',
        'Quantity',
        'Boxes',
        'Cost',
        'Price',
        'Minimum',
        'Stock value',
      ],
      rowsOf(
        await this.dataSource.query(
          `SELECT i.part_code, i.part_name, sh.name AS shop, cat.name AS category,
                  u.label AS unit, sup.name AS supplier,
                  i.quantity::text, i.box_count,
                  i.purchase_price::text, i.unit_price::text, i.minimum_stock,
                  round(i.quantity * i.unit_price, 2)::text AS stock_value
             FROM inventory_items i
             JOIN shops sh ON sh.id = i.shop_id
             JOIN units u ON u.id = i.unit_id
             LEFT JOIN categories cat ON cat.id = i.category_id
             LEFT JOIN suppliers sup ON sup.id = i.supplier_id
            ORDER BY sh.name, i.part_name`,
        ),
      ),
      { money: ['Cost', 'Price', 'Stock value'], number: ['Quantity'] },
    );

    this.addSheet(
      workbook,
      'Expenses',
      [
        'Date',
        'Category',
        'Description',
        'Amount',
        'Paid to',
        'Receipt',
        'Method',
        'Shop',
      ],
      rowsOf(
        await this.dataSource.query(
          `SELECT e.date::text, ec.label AS category, e.description, e.amount::text,
                  e.paid_to, e.receipt_number, m.label AS method,
                  COALESCE(sh.name, '(business-wide)') AS shop
             FROM expenses e
             JOIN expense_categories ec ON ec.id = e.expense_category_id
             LEFT JOIN payment_methods m ON m.id = e.payment_method_id
             LEFT JOIN shops sh ON sh.id = e.shop_id
            ORDER BY e.date DESC`,
        ),
      ),
      { money: ['Amount'] },
    );

    this.addSheet(
      workbook,
      'Payments',
      ['Receipt', 'Date', 'Sale', 'Customer', 'Shop', 'Amount', 'Method'],
      rowsOf(
        await this.dataSource.query(
          `SELECT p.receipt_number, p.payment_date::text, s.sale_number,
                  c.name AS customer, sh.name AS shop, p.amount::text, m.label AS method
             FROM sale_payments p
             JOIN sales s ON s.id = p.sale_id
             JOIN customers c ON c.id = s.customer_id
             JOIN shops sh ON sh.id = s.shop_id
             JOIN payment_methods m ON m.id = p.payment_method_id
            ORDER BY p.payment_date DESC`,
        ),
      ),
      { money: ['Amount'] },
    );

    return workbook.xlsx.writeBuffer();
  }

  /**
   * FR-09.4 — the customer financial summary: every customer with total
   * invoiced, paid and due, formatted with a grand-total row.
   */
  async customerSummary(): Promise<ExcelJS.Buffer> {
    const workbook = this.newWorkbook();

    /*
     * `addSheet` writes `Object.values(row)` positionally, so THE SELECT ORDER
     * IS THE COLUMN ORDER. This query used to end `..., due, orders` under
     * headers reading `Orders, Invoiced, Received, Due`, which shifted every
     * figure one column left and parked the order count under "Due" — a
     * customer owing 8,000.00 reported a due of 3.00, the number of orders they
     * had placed. Keep the two lists below in the same order.
     */
    const headers = [
      'Customer ID',
      'Name',
      'Company',
      'Phone',
      'Shop',
      'Orders',
      'Invoiced',
      'Received',
      'Due',
    ];

    const rows = rowsOf<Record<string, string>>(
      await this.dataSource.query(
        `SELECT c.customer_id, c.name, c.company, c.phone, sh.name AS shop,
                COALESCE(s.orders, 0)::text     AS orders,
                COALESCE(s.invoiced, 0)::text   AS invoiced,
                COALESCE(s.received, 0)::text   AS received,
                COALESCE(s.due, 0)::text        AS due
           FROM customers c
           JOIN shops sh ON sh.id = c.shop_id
           LEFT JOIN LATERAL (
             SELECT SUM(total_amount) AS invoiced, SUM(amount_paid) AS received,
                    SUM(total_amount - amount_paid) AS due, count(*) AS orders
               FROM sales
              WHERE customer_id = c.id AND status_code = 'finalized') s ON true
          ORDER BY COALESCE(s.due, 0) DESC, c.name`,
      ),
    );

    const sheet = this.addSheet(workbook, 'Customer summary', headers, rows, {
      money: ['Invoiced', 'Received', 'Due'],
      count: ['Orders'],
    });

    /*
     * The grand-total row FR-09.4 asks for. It is a real SUM formula rather
     * than a computed constant, so the figure survives someone filtering or
     * sorting the sheet.
     *
     * The letters come from where each header actually sits. Hard-coded ones
     * are what let the column bug above go unnoticed: they kept totalling
     * whatever had drifted into F, G and H.
     */
    const columnOf = (header: string) =>
      sheet.getColumn(headers.indexOf(header) + 1).letter;
    const summed = new Set(['Orders', 'Invoiced', 'Received', 'Due']);

    const last = sheet.rowCount;
    const total = sheet.addRow(
      headers.map((header, index) => {
        if (index === 0) return 'TOTAL';
        if (!summed.has(header)) return '';
        const letter = columnOf(header);
        return { formula: `SUM(${letter}2:${letter}${last})` };
      }),
    );
    total.font = { bold: true };
    total.eachCell((cell) => {
      cell.border = { top: { style: 'double' } };
    });
    for (const header of summed) {
      sheet.getCell(`${columnOf(header)}${total.number}`).numFmt =
        header === 'Orders' ? '#,##0' : '#,##0.00';
    }

    return workbook.xlsx.writeBuffer();
  }

  private newWorkbook(): ExcelJS.Workbook {
    const workbook = new ExcelJS.Workbook();
    workbook.creator = 'Fashion Express';
    workbook.created = new Date();
    return workbook;
  }

  private addSheet(
    workbook: ExcelJS.Workbook,
    name: string,
    headers: string[],
    rows: Array<Record<string, unknown>>,
    formats: { money?: string[]; number?: string[]; count?: string[] } = {},
  ): ExcelJS.Worksheet {
    const sheet = workbook.addWorksheet(name);
    const header = sheet.addRow(headers);
    header.font = { bold: true };
    header.eachCell((cell) => {
      cell.fill = {
        type: 'pattern',
        pattern: 'solid',
        fgColor: { argb: 'FFEFEFEF' },
      };
    });
    sheet.views = [{ state: 'frozen', ySplit: 1 }];

    const moneyColumns = new Set(formats.money ?? []);
    const numberColumns = new Set(formats.number ?? []);
    // Whole things — orders, items. `number` formats to three decimals for
    // quantities, which reads as 3.000 orders.
    const countColumns = new Set(formats.count ?? []);

    for (const row of rows) {
      sheet.addRow(
        Object.values(row).map((value, index) => {
          const columnName = headers[index];
          if (
            value !== null &&
            (moneyColumns.has(columnName) ||
              numberColumns.has(columnName) ||
              countColumns.has(columnName))
          ) {
            // Text will not sum. Convert only here, at the boundary.
            return Number(value);
          }
          return value;
        }),
      );
    }

    headers.forEach((columnName, index) => {
      const column = sheet.getColumn(index + 1);
      column.width = Math.max(12, Math.min(40, columnName.length + 6));
      if (moneyColumns.has(columnName)) column.numFmt = '#,##0.00';
      if (numberColumns.has(columnName)) column.numFmt = '#,##0.000';
      if (countColumns.has(columnName)) column.numFmt = '#,##0';
    });

    return sheet;
  }
}
