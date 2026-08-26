# Reports, exports and documents

FR-09 and FR-02.9. **Reports are manager-only** (FR-09.5); documents are not,
because a salesperson has to be able to print the invoice they just raised —
but **BR-01 still applies to them**.

---

## `GET /api/reports/summary`

**Permission:** `view_ledger` + manager.

FR-09.2 carries the balance through from the ledger; FR-09.6 breaks the trading
figures down by shop.

```json
{
  "ledger": { "balance": "22800.00", "credits": "30450.00", "debits": "7650.00" },
  "trading": { "invoiced": "50600.00", "received": "30450.00", "outstanding": "20150.00" },
  "byShop": [
    {
      "name": "Gulshan Branch",
      "invoiced": "50600.00",
      "received": "30450.00",
      "outstanding": "20150.00",
      "stock_value": "8050.00",
      "customer_count": "4",
      "attributed_expenses": "0"
    }
  ]
}
```

### Why there is no per-shop net profit

`attributed_expenses` counts **only** the expenses explicitly given that shop.
Revenue is shop-scoped, so gross figures per shop are real — but many expenses
are business-wide by design (§10.2), and dividing them between shops would be
arbitrary. So the report gives what the data supports and does not invent a net
profit line. If per-shop profitability is wanted, the fix is upstream: attribute
the expenses.

---

## `GET /api/reports/export/full`

**Permission:** `export_data` + manager. FR-09.3.

One workbook, five sheets: Employees, Customers, Inventory, Expenses, Payments.
Shop is a column on the customer, inventory, expense and payment sheets
(FR-09.6).

```bash
curl -s -b $JAR -OJ "$BASE/reports/export/full"
```

Returns `.xlsx` as an attachment.

**Money is written as a number with a display format, not as text.** A cell
holding `"1500.00"` is a string: it will not sum, and a total row over it reads
zero. The value is converted at that boundary and nowhere earlier, so exact
decimals hold right up to the point the format demands otherwise.

Labels are exported, never ids — an export selecting foreign keys fills the
sheet with integers nobody can read.

## `GET /api/reports/export/customers`

FR-09.4 — every customer with total invoiced, paid and due, with a **grand-total
row**. The totals are real `SUM` formulas rather than baked-in constants, so they
survive the reader sorting or filtering the sheet.

---

## Documents (FR-02.9)

All PDFs carry the configured business name, address, phone and email (FR-10.1),
read from the settings row — change the letterhead once and every future
document follows.

| Route | Produces |
|-------|----------|
| `GET /api/documents/sales/:id/invoice` | The invoice, or the **quotation** template if the sale is a quotation |
| `GET /api/documents/sales/:id/statement` | Payment history for that sale, formatted, with a running total |
| `GET /api/documents/sales/:id/payments.csv` | The same history as CSV |
| `GET /api/documents/payments/:id/receipt` | A receipt for one payment |
| `GET /api/documents/orders.csv` | Order history across sales |
| `GET /api/documents/orders.pdf` | The same, landscape, with totals |

```bash
curl -s -b $JAR -OJ "$BASE/documents/sales/1/invoice"
```

### The quotation template

A quotation prints as a **distinct document**, not an invoice with a different
word at the top. It is titled `QUOTATION`, states plainly that *"This is a
quotation, not an invoice. No payment is due against this document."*, and shows
a validity date 30 days from issue. The filename says `quotation-` too.

That matters commercially: a document that looks like an invoice but is not one
gets paid, or gets argued about.

Quotations omit the Received and Balance due lines entirely — there is nothing
owed against an offer.

### Totals on the order report

`orders.pdf` totals **finalised sales only** (BR-03), even though the table lists
drafts and quotations too. The total row says so.

### BR-01 applies here

A printable invoice is very much *reading* a sale, so the same scope applies: an
employee requesting another user's invoice gets **404**, and `orders.csv` /
`orders.pdf` contain only their own sales. There is no route by which a
non-manager reads another user's sale — including a document route.
