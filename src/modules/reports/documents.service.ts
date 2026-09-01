import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import type { Content, TDocumentDefinitions } from 'pdfmake/interfaces';
import { DataSource } from 'typeorm';
import { firstRow, rowsOf } from '../../common/sql';

/**
 * FR-02.9 — printable documents and per-sale exports.
 *
 * Every document carries the configured business name, address, phone and email
 * (FR-10.1), read from the singleton settings row rather than hard-coded, so
 * changing the letterhead changes every future document at once.
 *
 * pdfmake needs real font files. Rather than ship binaries, the standard PDF
 * base-14 fonts are used — they are built into every PDF reader, produce a
 * smaller file, and are perfectly adequate for an invoice.
 */
/** CommonJS interop: these modules export on `.default` under `__esModule`. */
function loadDefault(module: unknown): unknown {
  return (module as { default?: unknown }).default ?? module;
}

interface PdfPrinterLike {
  /** Async since 0.3 — it resolves remote assets before laying anything out. */
  createPdfKitDocument(
    definition: TDocumentDefinitions,
  ): Promise<NodeJS.ReadableStream & { end(): void }>;
}
type PdfPrinterConstructor = new (
  fonts: Record<string, unknown>,
  virtualfs?: unknown,
  urlResolver?: unknown,
  localAccessPolicy?: unknown,
) => PdfPrinterLike;

/* eslint-disable @typescript-eslint/no-require-imports */
const printerModule: unknown = require('pdfmake/js/Printer');
const PdfPrinter = ((printerModule as { default?: unknown }).default ??
  printerModule) as PdfPrinterConstructor;

/**
 * pdfmake 0.3's printer takes three collaborators beyond the fonts, and
 * `resolveUrls` dereferences the URL resolver **unconditionally** — once per
 * font face, even for the base-14 names that resolve to nothing. Omitting it is
 * therefore a crash rather than a degradation, so a real resolver is
 * constructed over the virtual filesystem.
 *
 * Nothing in these documents fetches a remote asset, so the resolver never
 * actually goes anywhere; it exists to satisfy that unconditional call.
 */
const virtualFs = loadDefault(require('pdfmake/js/virtual-fs'));
const UrlResolver = loadDefault(require('pdfmake/js/URLResolver')) as new (
  fs: unknown,
) => unknown;
const urlResolver = new UrlResolver(virtualFs);

/**
 * The four faces these documents use.
 *
 * pdfmake treats a base-14 font *name* as a local file reference and puts it
 * through the local-access policy, so the policy has to admit them by name.
 * Listing them rather than returning `true` keeps the policy doing its job:
 * nothing here reads from disk, and a document that asked for some other file
 * is a bug worth failing on.
 */
const STANDARD_FACES = new Set([
  'Helvetica',
  'Helvetica-Bold',
  'Helvetica-Oblique',
  'Helvetica-BoldOblique',
]);
/* eslint-enable @typescript-eslint/no-require-imports */

@Injectable()
export class DocumentsService {
  /**
   * `@types/pdfmake` describes the *browser* entry point, which has no
   * constructor at all — `pdfmake` itself resolves to the client bundle. The
   * server-side renderer is `pdfmake/js/Printer` (capital P), CommonJS and
   * untyped, so it is required and given a minimal interface above rather than
   * imported.
   */
  private readonly printer = new PdfPrinter(
    {
      Helvetica: {
        normal: 'Helvetica',
        bold: 'Helvetica-Bold',
        italics: 'Helvetica-Oblique',
        bolditalics: 'Helvetica-BoldOblique',
      },
    },
    virtualFs,
    urlResolver,
    (path: string) => STANDARD_FACES.has(path),
  );

  constructor(@InjectDataSource() private readonly dataSource: DataSource) {}

  private async business(): Promise<Record<string, string>> {
    return (
      firstRow<Record<string, string>>(
        await this.dataSource.query(
          `SELECT name, address, phone, email, invoice_footer
             FROM business_settings WHERE id = 1`,
        ),
      ) ?? {
        name: 'Fashion Express',
        address: '',
        phone: '',
        email: '',
        invoice_footer: '',
      }
    );
  }

  private money(value: string | number): string {
    return Number(value).toLocaleString('en-US', {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    });
  }

  private letterhead(business: Record<string, string>): Content[] {
    const lines = [business.address, business.phone, business.email].filter(
      Boolean,
    );
    const header: Content[] = [{ text: business.name, style: 'businessName' }];
    if (lines.length > 0) {
      header.push({ text: lines.join('  ·  '), style: 'businessMeta' });
    }
    return header;
  }

  private async render(definition: TDocumentDefinitions): Promise<Buffer> {
    const doc = await this.printer.createPdfKitDocument(definition);
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      doc.on('data', (chunk: Buffer) => chunks.push(chunk));
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.on('error', reject);
      doc.end();
    });
  }

  private async saleWithItems(id: string): Promise<{
    sale: Record<string, string>;
    items: Array<Record<string, string>>;
  }> {
    const sale = firstRow<Record<string, string>>(
      await this.dataSource.query(
        `SELECT s.id::text, s.sale_number, s.status_code, s.notes,
                s.total_amount::text, s.amount_paid::text,
                (s.total_amount - s.amount_paid)::text AS balance_due,
                s.created_at, s.finalized_at,
                c.name AS customer_name, c.customer_id AS customer_number,
                c.company, c.address AS customer_address, c.phone AS customer_phone,
                sh.name AS shop_name
           FROM sales s
           JOIN customers c ON c.id = s.customer_id
           JOIN shops sh ON sh.id = s.shop_id
          WHERE s.id = $1`,
        [id],
      ),
    );
    if (!sale) throw new NotFoundException('No such sale.');

    const items = rowsOf<Record<string, string>>(
      await this.dataSource.query(
        `SELECT i.description, i.quantity::text, i.boxes,
                i.unit_price::text, i.line_total::text,
                COALESCE(inv.part_code, '') AS part_code,
                COALESCE(inv.part_name, '') AS part_name
           FROM sale_items i
           LEFT JOIN inventory_items inv ON inv.id = i.inventory_item_id
          WHERE i.sale_id = $1 ORDER BY i.id`,
        [id],
      ),
    );

    return { sale, items };
  }

  /**
   * The invoice, and the quotation, from one builder.
   *
   * FR-02.9 requires quotations to print on a **distinct template** marked as a
   * quotation, valid 30 days from issue, and explicitly stating that it is not
   * an invoice. That last part matters commercially — a document that looks
   * like an invoice but is not one gets paid, or gets argued about.
   */
  async saleDocument(
    id: string,
  ): Promise<{ buffer: Buffer; filename: string }> {
    const [{ sale, items }, business] = await Promise.all([
      this.saleWithItems(id),
      this.business(),
    ]);

    const isQuotation = sale.status_code === 'quote';
    const issued = new Date(sale.created_at);
    const validUntil = new Date(issued.getTime() + 30 * 24 * 60 * 60 * 1000);

    const body: Array<Array<unknown>> = [
      [
        { text: '#', style: 'th' },
        { text: 'Description', style: 'th' },
        { text: 'Qty', style: 'th', alignment: 'right' },
        { text: 'Boxes', style: 'th', alignment: 'right' },
        { text: 'Unit price', style: 'th', alignment: 'right' },
        { text: 'Amount', style: 'th', alignment: 'right' },
      ],
      ...items.map((item, index) => [
        { text: String(index + 1) },
        { text: item.description || item.part_code },
        { text: Number(item.quantity).toString(), alignment: 'right' },
        { text: String(item.boxes ?? 0), alignment: 'right' },
        { text: this.money(item.unit_price), alignment: 'right' },
        { text: this.money(item.line_total), alignment: 'right' },
      ]),
    ];

    const totals: Array<Array<unknown>> = [
      [
        {
          text: 'Total',
          bold: true,
          alignment: 'right',
          colSpan: 5,
          border: [false, true, false, false],
        },
        {},
        {},
        {},
        {},
        {
          text: this.money(sale.total_amount),
          bold: true,
          alignment: 'right',
          border: [false, true, false, false],
        },
      ],
    ];
    if (!isQuotation) {
      totals.push(
        [
          {
            text: 'Received',
            alignment: 'right',
            colSpan: 5,
            border: [false, false, false, false],
          },
          {},
          {},
          {},
          {},
          {
            text: this.money(sale.amount_paid),
            alignment: 'right',
            border: [false, false, false, false],
          },
        ],
        [
          {
            text: 'Balance due',
            bold: true,
            alignment: 'right',
            colSpan: 5,
            border: [false, false, false, false],
          },
          {},
          {},
          {},
          {},
          {
            text: this.money(sale.balance_due),
            bold: true,
            alignment: 'right',
            border: [false, false, false, false],
          },
        ],
      );
    }

    const definition: TDocumentDefinitions = {
      defaultStyle: { font: 'Helvetica', fontSize: 10 },
      pageMargins: [40, 40, 40, 60],
      content: [
        ...this.letterhead(business),
        {
          text: isQuotation ? 'QUOTATION' : 'INVOICE',
          style: 'docTitle',
          margin: [0, 16, 0, 2],
        },
        ...(isQuotation
          ? [
              {
                text: 'This is a quotation, not an invoice. No payment is due against this document.',
                style: 'quotationNotice',
              },
              {
                text: `Valid for 30 days — until ${validUntil.toISOString().slice(0, 10)}.`,
                style: 'businessMeta',
                margin: [0, 0, 0, 8],
              },
            ]
          : []),
        {
          columns: [
            {
              width: '*',
              stack: [
                { text: 'Billed to', style: 'label' },
                { text: sale.customer_name, bold: true },
                ...(sale.company ? [{ text: sale.company }] : []),
                ...(sale.customer_address
                  ? [{ text: sale.customer_address }]
                  : []),
                ...(sale.customer_phone ? [{ text: sale.customer_phone }] : []),
                { text: sale.customer_number, style: 'businessMeta' },
              ],
            },
            {
              width: 'auto',
              stack: [
                {
                  text: isQuotation ? 'Quotation no.' : 'Invoice no.',
                  style: 'label',
                },
                { text: sale.sale_number, bold: true },
                { text: 'Date', style: 'label', margin: [0, 6, 0, 0] },
                { text: issued.toISOString().slice(0, 10) },
                { text: 'Shop', style: 'label', margin: [0, 6, 0, 0] },
                { text: sale.shop_name },
              ],
              alignment: 'right',
            },
          ],
          margin: [0, 8, 0, 14],
        },
        {
          table: {
            headerRows: 1,
            widths: [16, '*', 50, 40, 70, 70],
            body: [...body, ...totals],
          },
          layout: 'lightHorizontalLines',
        },
        ...(sale.notes ? [{ text: sale.notes, margin: [0, 14, 0, 0] }] : []),
        ...(business.invoice_footer
          ? [
              {
                text: business.invoice_footer,
                style: 'footer',
                margin: [0, 20, 0, 0],
              },
            ]
          : []),
      ] as Content[],
      styles: {
        businessName: { fontSize: 18, bold: true },
        businessMeta: { fontSize: 9, color: '#555555' },
        docTitle: { fontSize: 15, bold: true },
        quotationNotice: { fontSize: 10, bold: true, color: '#8a5a00' },
        label: { fontSize: 8, color: '#777777', characterSpacing: 0.4 },
        th: { bold: true, fontSize: 9 },
        footer: { fontSize: 9, italics: true, color: '#555555' },
      },
    };

    return {
      buffer: await this.render(definition),
      filename: `${isQuotation ? 'quotation' : 'invoice'}-${sale.sale_number}.pdf`,
    };
  }

  /** A printable receipt for one payment. */
  async receipt(
    paymentId: string,
  ): Promise<{ buffer: Buffer; filename: string }> {
    const payment = firstRow<Record<string, string>>(
      await this.dataSource.query(
        `SELECT p.receipt_number, p.amount::text, p.payment_date::text, p.notes,
                m.label AS method, s.sale_number, s.total_amount::text,
                s.amount_paid::text, (s.total_amount - s.amount_paid)::text AS balance_due,
                c.name AS customer_name, c.customer_id AS customer_number,
                sh.name AS shop_name
           FROM sale_payments p
           JOIN payment_methods m ON m.id = p.payment_method_id
           JOIN sales s ON s.id = p.sale_id
           JOIN customers c ON c.id = s.customer_id
           JOIN shops sh ON sh.id = s.shop_id
          WHERE p.id = $1`,
        [paymentId],
      ),
    );
    if (!payment) throw new NotFoundException('No such payment.');

    const business = await this.business();

    const definition: TDocumentDefinitions = {
      defaultStyle: { font: 'Helvetica', fontSize: 10 },
      pageMargins: [40, 40, 40, 60],
      content: [
        ...this.letterhead(business),
        { text: 'PAYMENT RECEIPT', style: 'docTitle', margin: [0, 16, 0, 10] },
        {
          table: {
            widths: ['auto', '*'],
            body: [
              ['Receipt no.', payment.receipt_number],
              ['Date', payment.payment_date],
              [
                'Received from',
                `${payment.customer_name} (${payment.customer_number})`,
              ],
              ['Against invoice', payment.sale_number],
              ['Method', payment.method],
              ['Shop', payment.shop_name],
              [
                { text: 'Amount received', bold: true },
                { text: this.money(payment.amount), bold: true },
              ],
              ['Invoice total', this.money(payment.total_amount)],
              ['Total received', this.money(payment.amount_paid)],
              ['Balance due', this.money(payment.balance_due)],
            ],
          },
          layout: 'lightHorizontalLines',
        },
        ...(payment.notes
          ? [{ text: payment.notes, margin: [0, 12, 0, 0] }]
          : []),
      ] as Content[],
      styles: {
        businessName: { fontSize: 18, bold: true },
        businessMeta: { fontSize: 9, color: '#555555' },
        docTitle: { fontSize: 15, bold: true },
      },
    };

    return {
      buffer: await this.render(definition),
      filename: `receipt-${payment.receipt_number}.pdf`,
    };
  }

  /** FR-02.9 — the payment history for one sale, as a formatted PDF statement. */
  /**
   * FR-02.9 — the payment statement for one sale.
   *
   * Laid out as the console it replaces had it: letterhead opposite the
   * document's own identity, who it is addressed to, what was ordered, what has
   * been paid against it, and the three figures that settle the question. The
   * running-total column the earlier version carried is gone — a statement is
   * read for the balance at the bottom, and a second money column beside every
   * row invited the reader to check the arithmetic instead.
   */
  async statement(
    saleId: string,
  ): Promise<{ buffer: Buffer; filename: string }> {
    const [{ sale, items }, business] = await Promise.all([
      this.saleWithItems(saleId),
      this.business(),
    ]);
    const payments = rowsOf<Record<string, string>>(
      await this.dataSource.query(
        `SELECT p.receipt_number, p.payment_date::text, p.amount::text,
                m.label AS method, p.notes
           FROM sale_payments p JOIN payment_methods m ON m.id = p.payment_method_id
          WHERE p.sale_id = $1 ORDER BY p.payment_date, p.id`,
        [saleId],
      ),
    );

    // A stocked line carries its product's name; a machine line's description
    // IS the machine (BR-04), so it stands in.
    const products =
      items.map((item) => item.part_name || item.description).join(', ') || '—';

    const settled = Number(sale.balance_due) === 0;
    const ordered = sale.finalized_at ?? sale.created_at;

    /** A muted small-caps label above each block, as the old statement had. */
    const label = (text: string): Content => ({
      text,
      style: 'sectionLabel',
      margin: [0, 22, 0, 6],
    });

    const totalRow = (
      text: string,
      value: string,
      options: { bold?: boolean; color?: string } = {},
    ): Content => ({
      columns: [
        {
          text,
          fontSize: 11,
          bold: options.bold ?? false,
          color: options.bold ? INK : '#4a4a4a',
        },
        {
          text: this.money(value),
          alignment: 'right',
          fontSize: 13,
          bold: true,
          color: options.color ?? INK,
        },
      ],
      margin: [0, 9, 0, 9],
    });

    const definition: TDocumentDefinitions = {
      defaultStyle: { font: 'Helvetica', fontSize: 9.5, lineHeight: 1.25 },
      pageMargins: [45, 50, 45, 55],
      content: [
        {
          columns: [
            {
              width: '*',
              stack: [
                { text: business.name, style: 'businessName' },
                { text: business.address || '', style: 'businessMeta' },
              ],
            },
            {
              width: 'auto',
              alignment: 'right',
              stack: [
                { text: 'PAYMENT STATEMENT', style: 'docKind' },
                { text: `#${sale.sale_number}`, style: 'docNumber' },
                { text: longDate(), style: 'businessMeta' },
              ],
            },
          ],
        },
        {
          canvas: [rule(0, 505, 0.8, HAIRLINE)],
          margin: [0, 22, 0, 0],
        },

        label('BILL TO'),
        { text: sale.customer_name, style: 'billToName' },
        ...(sale.customer_phone
          ? [{ text: `Phone: ${sale.customer_phone}`, style: 'billToMeta' }]
          : []),
        ...(sale.customer_address
          ? [{ text: sale.customer_address, style: 'billToMeta' }]
          : []),

        label('ORDER SUMMARY'),
        {
          table: {
            headerRows: 1,
            widths: ['*', 'auto', 'auto', 'auto'],
            body: [
              [
                { text: 'PRODUCT', style: 'th' },
                { text: 'ORDER DATE', style: 'th' },
                { text: 'STATUS', style: 'th' },
                { text: 'AMOUNT', style: 'th', alignment: 'right' },
              ],
              [
                { text: products },
                { text: String(ordered).slice(0, 10) },
                { text: titleCase(sale.status_code), bold: true },
                {
                  text: this.money(sale.total_amount),
                  alignment: 'right',
                  bold: true,
                },
              ],
            ],
          },
          layout: statementTable,
        },

        label('PAYMENT HISTORY'),
        payments.length === 0
          ? {
              text: 'No payments have been recorded against this sale.',
              italics: true,
              color: '#8a8a8a',
            }
          : {
              table: {
                headerRows: 1,
                widths: [95, 'auto', 'auto', '*', 'auto'],
                body: [
                  [
                    { text: 'RECEIPT', style: 'th' },
                    { text: 'DATE', style: 'th' },
                    { text: 'METHOD', style: 'th' },
                    { text: 'NOTES', style: 'th' },
                    { text: 'AMOUNT', style: 'th', alignment: 'right' },
                  ],
                  ...payments.map((payment) => [
                    { text: payment.receipt_number },
                    { text: payment.payment_date },
                    { text: payment.method },
                    { text: payment.notes || '-' },
                    {
                      text: this.money(payment.amount),
                      alignment: 'right',
                      bold: true,
                    },
                  ]),
                ],
              },
              layout: statementTable,
            },

        { canvas: [rule(0, 505, 0.8, HAIRLINE)], margin: [0, 30, 0, 0] },
        totalRow('Total Amount', sale.total_amount),
        totalRow('Total Paid', sale.amount_paid, { color: PAID }),
        // The heavier rule is the old statement's way of marking the line the
        // whole page is read for.
        { canvas: [rule(0, 505, 1.6, INK)] },
        totalRow('Balance Due', sale.balance_due, {
          bold: true,
          color: settled ? PAID : OWING,
        }),
      ] as Content[],
      footer: () => ({
        stack: [
          { canvas: [rule(0, 505, 0.8, HAIRLINE)] },
          {
            text: `This is a computer-generated document. Generated on ${longDate()} at ${clockTime()}.`,
            style: 'businessMeta',
            margin: [0, 8, 0, 0],
          },
        ],
        margin: [45, 10, 45, 0],
      }),
      styles: {
        businessName: { fontSize: 20, bold: true, color: INK },
        businessMeta: { fontSize: 8.5, color: '#8a8a8a' },
        docKind: { fontSize: 11, color: '#6a6a6a', characterSpacing: 0.6 },
        docNumber: {
          fontSize: 15,
          bold: true,
          color: INK,
          margin: [0, 2, 0, 2],
        },
        sectionLabel: {
          fontSize: 8,
          bold: true,
          color: '#9a9a9a',
          characterSpacing: 0.8,
        },
        billToName: { fontSize: 14, bold: true, color: INK },
        billToMeta: { fontSize: 9, color: '#5a5a5a' },
        th: {
          fontSize: 8,
          bold: true,
          color: '#5a5a5a',
          characterSpacing: 0.4,
          fillColor: HEAD_TINT,
        },
      },
    };

    return {
      buffer: await this.render(definition),
      filename: `statement-${sale.sale_number}.pdf`,
    };
  }

  /** FR-02.9 — the payment history for one sale as CSV. */
  async paymentsCsv(
    saleId: string,
  ): Promise<{ csv: string; filename: string }> {
    const { sale } = await this.saleWithItems(saleId);
    const payments = rowsOf<Record<string, string>>(
      await this.dataSource.query(
        `SELECT p.receipt_number, p.payment_date::text, p.amount::text,
                m.label AS method, p.notes
           FROM sale_payments p JOIN payment_methods m ON m.id = p.payment_method_id
          WHERE p.sale_id = $1 ORDER BY p.payment_date, p.id`,
        [saleId],
      ),
    );
    return {
      csv: toCsv(['Receipt', 'Date', 'Amount', 'Method', 'Notes'], payments),
      filename: `payments-${sale.sale_number}.csv`,
    };
  }

  /**
   * FR-02.9 — order history across sales as CSV.
   *
   * Takes the caller's visibility scope as a WHERE fragment, because BR-01
   * covers "all exports" as much as it covers the list.
   */
  async ordersCsv(
    scope: { clause: string; params: unknown[] },
    customer?: ExportCustomer,
  ): Promise<{ csv: string; filename: string }> {
    const rows = rowsOf<Record<string, string>>(
      await this.dataSource.query(
        `SELECT s.sale_number, s.created_at::date::text AS created,
                s.status_code AS status, c.customer_id AS customer_number,
                c.name AS customer, sh.name AS shop,
                s.total_amount::text, s.amount_paid::text,
                (s.total_amount - s.amount_paid)::text AS balance_due,
                COALESCE(u.username, '') AS created_by
           FROM sales s
           JOIN customers c ON c.id = s.customer_id
           JOIN shops sh ON sh.id = s.shop_id
           LEFT JOIN users u ON u.id = s.created_by_id
           ${scope.clause}
          ORDER BY s.created_at DESC`,
        scope.params,
      ),
    );
    return {
      csv: toCsv(
        [
          'Sale number',
          'Date',
          'Status',
          'Customer ID',
          'Customer',
          'Shop',
          'Total',
          'Received',
          'Balance due',
          'Created by',
        ],
        rows,
      ),
      filename: ordersFilename(customer, 'csv'),
    };
  }

  /** FR-02.9 — the same order history as a landscape PDF with totals. */
  async ordersPdf(
    scope: { clause: string; params: unknown[] },
    customer?: ExportCustomer,
  ): Promise<{ buffer: Buffer; filename: string }> {
    const business = await this.business();
    const rows = rowsOf<Record<string, string>>(
      await this.dataSource.query(
        `SELECT s.sale_number, s.created_at::date::text AS created, s.status_code,
                c.name AS customer, sh.name AS shop,
                s.total_amount::text, s.amount_paid::text,
                (s.total_amount - s.amount_paid)::text AS balance_due
           FROM sales s
           JOIN customers c ON c.id = s.customer_id
           JOIN shops sh ON sh.id = s.shop_id
           ${scope.clause}
          ORDER BY s.created_at DESC`,
        scope.params,
      ),
    );

    /*
     * BR-03 — only finalised sales carry money.
     *
     * The one-customer report lists finalised sales ONLY, because it reads as
     * a statement of that account: a quotation sitting beside real invoices
     * shows a balance nobody owes, and the totals underneath would not add up
     * to the column above them. The all-customers report is a different
     * document — an audit of what was raised — so it keeps every status and
     * says in its totals row which of them counted.
     */
    const finalised = rows.filter((r) => r.status_code === 'finalized');
    const listed = customer ? finalised : rows;
    const sum = (key: string) =>
      finalised.reduce((total, row) => total + Number(row[key]), 0);

    /*
     * A single customer is named once in the header, so repeating it down a
     * column — beside a Status column reading "finalized" all the way down —
     * would be width spent saying nothing.
     */
    type Column = {
      header: string;
      value: (row: Record<string, string>) => string;
      width: string | number;
      money?: boolean;
    };

    const columns: Column[] = [
      { header: 'Sale Number', value: (r) => r.sale_number, width: 'auto' },
      { header: 'Date', value: (r) => r.created, width: 'auto' },
      ...(customer
        ? []
        : ([
            { header: 'Status', value: (r) => r.status_code, width: 'auto' },
            { header: 'Customer', value: (r) => r.customer, width: '*' },
          ] as Column[])),
      { header: 'Shop', value: (r) => r.shop, width: '*' },
      {
        header: 'Total',
        value: (r) => this.money(r.total_amount),
        width: 80,
        money: true,
      },
      {
        header: 'Paid',
        value: (r) => this.money(r.amount_paid),
        width: 80,
        money: true,
      },
      {
        header: 'Due',
        value: (r) => this.money(r.balance_due),
        width: 80,
        money: true,
      },
    ];

    // Where the money columns start — the label before them spans everything
    // to its left, so the three figures line up under their own headers.
    const moneyFrom = columns.findIndex((column) => column.money);

    const body = [
      columns.map((column) => ({
        text: column.header,
        style: 'th',
        alignment: column.money ? 'right' : 'left',
      })),
      ...listed.map((row, index) =>
        columns.map((column) => ({
          text: column.value(row),
          alignment: column.money ? 'right' : 'left',
          // Banded rows: across a wide table the eye tracks a figure back to
          // its sale number far better than it does on flat white.
          fillColor: index % 2 === 1 ? BAND : undefined,
        })),
      ),
      [
        {
          text: customer ? 'TOTAL' : 'TOTAL (finalised only)',
          bold: true,
          alignment: 'right',
          colSpan: moneyFrom,
          fillColor: TOTAL_BAND,
        },
        ...Array.from({ length: moneyFrom - 1 }, () => ({
          text: '',
          fillColor: TOTAL_BAND,
        })),
        ...['total_amount', 'amount_paid', 'balance_due'].map((key) => ({
          text: this.money(sum(key)),
          bold: true,
          alignment: 'right',
          fillColor: TOTAL_BAND,
        })),
      ],
    ] as Content[][];

    const definition: TDocumentDefinitions = {
      pageOrientation: 'landscape',
      defaultStyle: { font: 'Helvetica', fontSize: 9, lineHeight: 1.2 },
      pageMargins: [40, 40, 40, 55],
      content: [
        /*
         * The letterhead sits opposite when the report was run. A printed page
         * outlives the screen that produced it, so it has to date itself.
         */
        {
          columns: [
            {
              width: '*',
              stack: [
                { text: business.name, style: 'businessName' },
                { text: 'Financial Report', style: 'businessMeta' },
              ],
            },
            {
              width: 'auto',
              alignment: 'right',
              stack: [
                { text: `Report Date: ${longDate()}`, style: 'businessMeta' },
                { text: `Generated: ${clockTime()}`, style: 'businessMeta' },
              ],
            },
          ],
        },
        {
          text: customer ? 'Customer Orders Report' : 'Order History Report',
          style: 'docTitle',
          margin: [0, 18, 0, 4],
        },
        {
          text: customer
            ? `Finalised Sales  |  Customer: ${customer.name} (${customer.customer_id})`
            : 'All Sales  |  All Customers',
          style: 'docSubtitle',
        },
        {
          canvas: [
            {
              type: 'line',
              x1: 0,
              y1: 0,
              x2: 762,
              y2: 0,
              lineWidth: 2,
              lineColor: RULE,
            },
          ],
          margin: [0, 10, 0, 18],
        },
        listed.length === 0
          ? {
              text: 'No orders to report.',
              style: 'businessMeta',
              margin: [0, 10, 0, 0],
            }
          : {
              table: {
                headerRows: 1,
                widths: columns.map((column) => column.width),
                body,
              },
              layout: {
                hLineWidth: () => 0.5,
                vLineWidth: () => 0.5,
                hLineColor: () => GRID,
                vLineColor: () => GRID,
                // Rows read as a statement, not a spreadsheet — the figures
                // need air around them more than the page needs the space.
                paddingTop: () => 8,
                paddingBottom: () => 8,
                paddingLeft: () => 8,
                paddingRight: () => 8,
              },
            },
      ] as Content[],
      footer: (currentPage: number, pageCount: number) => ({
        stack: [
          {
            text: [
              { text: 'CONFIDENTIAL', bold: true, italics: true },
              {
                text: `  ·  ${business.invoice_footer || 'This report contains proprietary information'}  ·  ${business.name} © ${new Date().getFullYear()}`,
                italics: true,
              },
            ],
            alignment: 'center',
            fontSize: 7.5,
            color: '#8a8a8a',
          },
          {
            text: `Page ${currentPage} of ${pageCount}`,
            alignment: 'center',
            fontSize: 7.5,
            color: '#b0b0b0',
            margin: [0, 3, 0, 0],
          },
        ],
        margin: [40, 12, 40, 0],
      }),
      styles: {
        businessName: { fontSize: 13, bold: true, color: HEADING },
        businessMeta: { fontSize: 8, color: '#666666' },
        docTitle: { fontSize: 22, bold: true, color: HEADING },
        docSubtitle: { fontSize: 10.5, color: '#5a6b7a' },
        th: { bold: true, fontSize: 8, color: '#ffffff', fillColor: HEAD_BG },
      },
    };

    return {
      buffer: await this.render(definition),
      filename: ordersFilename(customer, 'pdf'),
    };
  }
}

/** The statement palette — near-black on white, one green, one red. */
const INK = '#1c1c1c';
const HAIRLINE = '#dcdcdc';
const HEAD_TINT = '#f4f5f6';
const PAID = '#129a63';
const OWING = '#c0392b';

/** A full-width horizontal line at the current cursor. */
function rule(
  x: number,
  width: number,
  thickness: number,
  color: string,
): {
  type: 'line';
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  lineWidth: number;
  lineColor: string;
} {
  return {
    type: 'line',
    x1: x,
    y1: 0,
    x2: width,
    y2: 0,
    lineWidth: thickness,
    lineColor: color,
  };
}

/** 'finalized' -> 'Finalized'. */
function titleCase(value: string): string {
  return value ? value[0].toUpperCase() + value.slice(1) : '';
}

/**
 * Header band, no vertical rules, one hairline under each row — the statement's
 * tables are read across, so the columns need no walls between them.
 */
const statementTable = {
  hLineWidth: (i: number, node: { table: { body: unknown[] } }) =>
    i === 0 || i === node.table.body.length ? 0 : 0.8,
  vLineWidth: () => 0,
  hLineColor: () => HAIRLINE,
  paddingTop: () => 9,
  paddingBottom: () => 9,
  paddingLeft: (i: number) => (i === 0 ? 10 : 8),
  paddingRight: (i: number, node: { table: { widths?: unknown[] } }) =>
    i === (node.table.widths?.length ?? 0) - 1 ? 10 : 8,
};

/** The report palette, taken from the console this replaces. */
const HEADING = '#2c3e50';
const HEAD_BG = '#34495e';
const BAND = '#f7f9fb';
const TOTAL_BAND = '#dce4ec';
const GRID = '#c8d2dc';
const RULE = '#b0bec5';

/** "September 01, 2026" and "11:56 AM" — Dhaka, per NFR-05. */
const DHAKA = 'Asia/Dhaka';

function longDate(): string {
  return new Intl.DateTimeFormat('en-US', {
    timeZone: DHAKA,
    month: 'long',
    day: '2-digit',
    year: 'numeric',
  }).format(new Date());
}

function clockTime(): string {
  return new Intl.DateTimeFormat('en-US', {
    timeZone: DHAKA,
    hour: '2-digit',
    minute: '2-digit',
    hour12: true,
  }).format(new Date());
}

/** Named so two customers' exports do not land in Downloads as the same file. */
export type ExportCustomer = { customer_id: string; name: string };

function ordersFilename(
  customer: ExportCustomer | undefined,
  extension: 'csv' | 'pdf',
): string {
  const today = new Date().toISOString().slice(0, 10);
  const who = customer ? `-${customer.customer_id}` : '';
  return `orders${who}-${today}.${extension}`;
}

/**
 * CSV that a spreadsheet will actually open correctly.
 *
 * A value containing a comma, a quote or a newline must be quoted and its
 * quotes doubled — otherwise one customer called `Karim, Sons` silently shifts
 * every column after it.
 */
function toCsv(
  headers: string[],
  rows: Array<Record<string, unknown>>,
): string {
  const escape = (value: unknown): string => {
    // Every column here is a string, number or null out of PostgreSQL. Anything
    // else would stringify as "[object Object]" and quietly corrupt a column,
    // so it is turned into JSON rather than guessed at.
    let text: string;
    if (value === null || value === undefined) text = '';
    else if (typeof value === 'string') text = value;
    else if (typeof value === 'number' || typeof value === 'boolean')
      text = String(value);
    else if (value instanceof Date) text = value.toISOString();
    else text = JSON.stringify(value);

    return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  };
  return [
    headers.join(','),
    ...rows.map((row) => Object.values(row).map(escape).join(',')),
  ].join('\r\n');
}
