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
                COALESCE(inv.part_code, '') AS part_code
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
  async statement(
    saleId: string,
  ): Promise<{ buffer: Buffer; filename: string }> {
    const [{ sale }, business] = await Promise.all([
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

    let running = 0;
    const body: Array<Array<unknown>> = [
      [
        { text: 'Date', style: 'th' },
        { text: 'Receipt', style: 'th' },
        { text: 'Method', style: 'th' },
        { text: 'Amount', style: 'th', alignment: 'right' },
        { text: 'Running total', style: 'th', alignment: 'right' },
      ],
      ...payments.map((payment) => {
        running += Number(payment.amount);
        return [
          { text: payment.payment_date },
          { text: payment.receipt_number },
          { text: payment.method },
          { text: this.money(payment.amount), alignment: 'right' },
          { text: this.money(running), alignment: 'right' },
        ];
      }),
    ];

    const definition: TDocumentDefinitions = {
      defaultStyle: { font: 'Helvetica', fontSize: 10 },
      pageMargins: [40, 40, 40, 60],
      content: [
        ...this.letterhead(business),
        { text: 'PAYMENT STATEMENT', style: 'docTitle', margin: [0, 16, 0, 4] },
        {
          text: `${sale.sale_number} — ${sale.customer_name} (${sale.customer_number})`,
          margin: [0, 0, 0, 12],
        },
        payments.length
          ? {
              table: {
                headerRows: 1,
                widths: ['auto', '*', 'auto', 70, 80],
                body,
              },
              layout: 'lightHorizontalLines',
            }
          : {
              text: 'No payments have been recorded against this sale.',
              italics: true,
            },
        {
          margin: [0, 14, 0, 0],
          table: {
            widths: ['*', 80],
            body: [
              [
                { text: 'Invoice total', alignment: 'right' },
                { text: this.money(sale.total_amount), alignment: 'right' },
              ],
              [
                { text: 'Total received', alignment: 'right' },
                { text: this.money(sale.amount_paid), alignment: 'right' },
              ],
              [
                { text: 'Balance due', alignment: 'right', bold: true },
                {
                  text: this.money(sale.balance_due),
                  alignment: 'right',
                  bold: true,
                },
              ],
            ],
          },
          layout: 'noBorders',
        },
      ] as Content[],
      styles: {
        businessName: { fontSize: 18, bold: true },
        businessMeta: { fontSize: 9, color: '#555555' },
        docTitle: { fontSize: 15, bold: true },
        th: { bold: true, fontSize: 9 },
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
  async ordersCsv(scope: {
    clause: string;
    params: unknown[];
  }): Promise<{ csv: string; filename: string }> {
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
      filename: `orders-${new Date().toISOString().slice(0, 10)}.csv`,
    };
  }

  /** FR-02.9 — the same order history as a landscape PDF with totals. */
  async ordersPdf(scope: {
    clause: string;
    params: unknown[];
  }): Promise<{ buffer: Buffer; filename: string }> {
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

    // BR-03 — only finalised sales contribute to the totals, whatever the
    // report happens to be listing.
    const finalised = rows.filter((r) => r.status_code === 'finalized');
    const sum = (key: string) =>
      finalised.reduce((total, row) => total + Number(row[key]), 0);

    const definition: TDocumentDefinitions = {
      pageOrientation: 'landscape',
      defaultStyle: { font: 'Helvetica', fontSize: 9 },
      pageMargins: [30, 30, 30, 40],
      content: [
        ...this.letterhead(business),
        { text: 'ORDER HISTORY', style: 'docTitle', margin: [0, 12, 0, 10] },
        {
          table: {
            headerRows: 1,
            widths: ['auto', 'auto', 'auto', '*', 'auto', 70, 70, 70],
            body: [
              [
                { text: 'Sale number', style: 'th' },
                { text: 'Date', style: 'th' },
                { text: 'Status', style: 'th' },
                { text: 'Customer', style: 'th' },
                { text: 'Shop', style: 'th' },
                { text: 'Total', style: 'th', alignment: 'right' },
                { text: 'Received', style: 'th', alignment: 'right' },
                { text: 'Balance', style: 'th', alignment: 'right' },
              ],
              ...rows.map((row) => [
                { text: row.sale_number },
                { text: row.created },
                { text: row.status_code },
                { text: row.customer },
                { text: row.shop },
                { text: this.money(row.total_amount), alignment: 'right' },
                { text: this.money(row.amount_paid), alignment: 'right' },
                { text: this.money(row.balance_due), alignment: 'right' },
              ]),
              [
                { text: 'Totals (finalised only)', bold: true, colSpan: 5 },
                {},
                {},
                {},
                {},
                {
                  text: this.money(sum('total_amount')),
                  bold: true,
                  alignment: 'right',
                },
                {
                  text: this.money(sum('amount_paid')),
                  bold: true,
                  alignment: 'right',
                },
                {
                  text: this.money(sum('balance_due')),
                  bold: true,
                  alignment: 'right',
                },
              ],
            ],
          },
          layout: 'lightHorizontalLines',
        },
      ] as Content[],
      styles: {
        businessName: { fontSize: 16, bold: true },
        businessMeta: { fontSize: 8, color: '#555555' },
        docTitle: { fontSize: 13, bold: true },
        th: { bold: true, fontSize: 8 },
      },
    };

    return {
      buffer: await this.render(definition),
      filename: `orders-${new Date().toISOString().slice(0, 10)}.pdf`,
    };
  }
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
