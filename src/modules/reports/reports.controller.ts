import {
  Controller,
  Get,
  NotFoundException,
  Param,
  Query,
  Res,
} from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import type { Response } from 'express';
import { DataSource } from 'typeorm';
import { firstRow } from '../../common/sql';
import type { AuthUser } from '../auth/auth-user';
import {
  CurrentUser,
  RequireManager,
  RequirePermission,
} from '../auth/decorators';
import { DocumentsService } from './documents.service';
import { ReportsService } from './reports.service';

/**
 * FR-09 — reports and exports. **Manager-only** (FR-09.5), applied at the class.
 */
@Controller('reports')
@RequireManager()
export class ReportsController {
  constructor(private readonly reports: ReportsService) {}

  /** FR-09.2 and FR-09.6 — the balance, the trading totals, and the shop breakdown. */
  @Get('summary')
  @RequirePermission('view_ledger')
  summary() {
    return this.reports.summary();
  }

  /** FR-09.3 — the full data export: five sheets in one workbook. */
  @Get('export/full')
  @RequirePermission('export_data')
  async fullExport(@Res() res: Response): Promise<void> {
    const buffer = await this.reports.fullExport();
    send(res, toBuffer(buffer), `fashion-express-${today()}.xlsx`, XLSX);
  }

  /** FR-09.4 — every customer with invoiced, paid and due, plus a total row. */
  @Get('export/customers')
  @RequirePermission('export_data')
  async customerSummary(@Res() res: Response): Promise<void> {
    const buffer = await this.reports.customerSummary();
    send(res, toBuffer(buffer), `customer-summary-${today()}.xlsx`, XLSX);
  }
}

/**
 * FR-02.9 — the printable documents.
 *
 * Not manager-only: a salesperson has to be able to print the invoice for the
 * sale they just made. **BR-01 still applies** — the scope check runs before
 * anything is rendered, so a non-manager cannot print another user's sale any
 * more than they can read it.
 */
@Controller('documents')
export class DocumentsController {
  constructor(
    private readonly documents: DocumentsService,
    @InjectDataSource() private readonly dataSource: DataSource,
  ) {}

  /**
   * BR-01 as a WHERE fragment, the same rule the sales list applies,
   * optionally narrowed to one customer for the account-level export.
   *
   * Built as a list rather than a string because the two conditions can both
   * apply — an employee exporting one customer's orders gets their own sales
   * for that customer, not the customer's whole history. Placeholders are
   * numbered from the array so the order of the conditions cannot desync them.
   */
  private scope(
    user: AuthUser,
    customerId?: string,
  ): { clause: string; params: unknown[] } {
    const conditions: string[] = [];
    const params: unknown[] = [];

    if (!user.isSuperuser && !user.isManager) {
      params.push(user.id);
      conditions.push(`s.created_by_id = $${params.length}`);
    }

    if (customerId !== undefined) {
      params.push(customerId);
      conditions.push(`s.customer_id = $${params.length}`);
    }

    return {
      clause: conditions.length ? `WHERE ${conditions.join(' AND ')}` : '',
      params,
    };
  }

  /**
   * Resolves the `customerId` an export was asked to filter by, and names it so
   * the document can say whose history it is.
   *
   * Also the validation: the id reaches SQL as a bound parameter, so it cannot
   * inject, but a non-numeric one would make Postgres raise on the bigint cast
   * and answer 500. A malformed id and an absent customer both answer 404 —
   * which ids exist is not something to hand back either.
   */
  private async exportCustomer(
    customerId: string | undefined,
  ): Promise<{ customer_id: string; name: string } | undefined> {
    if (customerId === undefined) return undefined;

    const customer = /^\d+$/.test(customerId)
      ? firstRow<{ customer_id: string; name: string }>(
          await this.dataSource.query(
            'SELECT customer_id, name FROM customers WHERE id = $1',
            [customerId],
          ),
        )
      : undefined;

    if (!customer) throw new NotFoundException('No such customer.');
    return customer;
  }

  /**
   * BR-01 covers documents and exports as much as it covers the list — "there
   * is no route by which a non-manager can read another user's sale", and a
   * printable invoice is very much reading one. A sale outside the caller's
   * scope is reported as missing, never as forbidden.
   */
  private async assertVisible(id: string, user: AuthUser): Promise<void> {
    if (user.isSuperuser || user.isManager) return;
    const found = firstRow(
      await this.dataSource.query(
        `SELECT id FROM sales WHERE id = $1 AND created_by_id = $2`,
        [id, user.id],
      ),
    );
    if (!found) throw new NotFoundException('No such sale.');
  }

  /** The invoice, or the quotation template if the sale is a quotation. */
  @Get('sales/:id/invoice')
  @RequirePermission('view_sale')
  async invoice(
    @Param('id') id: string,
    @CurrentUser() user: AuthUser,
    @Res() res: Response,
  ): Promise<void> {
    await this.assertVisible(id, user);
    const { buffer, filename } = await this.documents.saleDocument(id);
    send(res, buffer, filename, PDF);
  }

  @Get('sales/:id/statement')
  @RequirePermission('view_sale')
  async statement(
    @Param('id') id: string,
    @CurrentUser() user: AuthUser,
    @Res() res: Response,
  ): Promise<void> {
    await this.assertVisible(id, user);
    const { buffer, filename } = await this.documents.statement(id);
    send(res, buffer, filename, PDF);
  }

  @Get('sales/:id/payments.csv')
  @RequirePermission('view_sale')
  async paymentsCsv(
    @Param('id') id: string,
    @CurrentUser() user: AuthUser,
    @Res() res: Response,
  ): Promise<void> {
    await this.assertVisible(id, user);
    const { csv, filename } = await this.documents.paymentsCsv(id);
    send(res, Buffer.from(csv, 'utf8'), filename, CSV);
  }

  /**
   * BR-01 reaches a receipt through the sale that owns it. The id in the path
   * is the PAYMENT's, so the sale has to be looked up before the scope check
   * can run — without it a non-manager could print another user's receipt by
   * walking payment ids, which is the one thing BR-01 exists to prevent.
   */
  @Get('payments/:id/receipt')
  @RequirePermission('view_sale')
  async receipt(
    @Param('id') id: string,
    @CurrentUser() user: AuthUser,
    @Res() res: Response,
  ): Promise<void> {
    const payment = firstRow<{ sale_id: string }>(
      await this.dataSource.query(
        'SELECT sale_id::text FROM sale_payments WHERE id = $1',
        [id],
      ),
    );
    if (!payment) throw new NotFoundException('No such payment.');
    await this.assertVisible(payment.sale_id, user);

    const { buffer, filename } = await this.documents.receipt(id);
    send(res, buffer, filename, PDF);
  }

  /** Order history across sales, scoped by BR-01 like every other read. */
  @Get('orders.csv')
  @RequirePermission('view_sale')
  async ordersCsv(
    @CurrentUser() user: AuthUser,
    @Query('customerId') customerId: string | undefined,
    @Res() res: Response,
  ): Promise<void> {
    const customer = await this.exportCustomer(customerId);
    const { csv, filename } = await this.documents.ordersCsv(
      this.scope(user, customerId),
      customer,
    );
    send(res, Buffer.from(csv, 'utf8'), filename, CSV);
  }

  @Get('orders.pdf')
  @RequirePermission('view_sale')
  async ordersPdf(
    @CurrentUser() user: AuthUser,
    @Query('customerId') customerId: string | undefined,
    @Res() res: Response,
  ): Promise<void> {
    const customer = await this.exportCustomer(customerId);
    const { buffer, filename } = await this.documents.ordersPdf(
      this.scope(user, customerId),
      customer,
    );
    send(res, buffer, filename, PDF);
  }
}

const XLSX =
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const PDF = 'application/pdf';
const CSV = 'text/csv; charset=utf-8';

const today = () => new Date().toISOString().slice(0, 10);

/** ExcelJS returns its own Buffer type; Express wants Node's. */
function toBuffer(value: unknown): Buffer {
  return Buffer.isBuffer(value) ? value : Buffer.from(value as ArrayBuffer);
}

/**
 * `Content-Disposition: attachment` matters: without it a browser renders the
 * PDF inline and "save as" offers the route name rather than the invoice
 * number.
 */
function send(
  res: Response,
  buffer: Buffer,
  filename: string,
  contentType: string,
): void {
  res.setHeader('Content-Type', contentType);
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.setHeader('Content-Length', buffer.length.toString());
  res.end(buffer);
}
