# Sales

FR-02. The largest module: quotations, invoices, stock draw-down and payments.

**Read this first: `BR-01` applies to every route here.** A user who is not a
manager or superuser sees **only the sales they created** — in the list, on the
detail page, in the line items, in the payment history. A sale they may not see
returns **404, not 403**: learning that it exists would already be more than the
rule allows.

---

## The four states (RD-03)

| State | Affects stock | Counts in totals |
|-------|---------------|------------------|
| `quote` | No | No |
| `draft` | No | No |
| `finalized` | **Yes — deducted** | **Yes** |
| `cancelled` | No | No |

**BR-02** — stock is untouched in every state except the transition *into*
finalised. Quotations and drafts can be edited freely without disturbing the
warehouse.

**BR-03** — drafts and quotations are excluded from every revenue and dues total
in the system, so a list showing drafts still reports totals over finalised
sales only.

---

## `GET /api/sales`

**Permission:** `view_sale`. Paginated at 10.

```bash
curl -s -b $JAR "$BASE/sales?status=finalized"
```

```json
{
  "items": [
    {
      "id": "1",
      "sale_number": "26-08-2026-FE-0001",
      "status_code": "finalized",
      "status_label": "Finalised",
      "total_amount": "25150.00",
      "amount_paid": "5000.00",
      "balance_due": "20150.00",
      "finalized_at": "2026-08-26T13:31:02.000Z",
      "customer_name": "Karim Traders",
      "customer_number": "FE26082026-01",
      "shop_name": "Gulshan Branch",
      "created_by": "owner"
    }
  ],
  "page": 1, "pageSize": 10, "total": 4, "totalPages": 1,
  "totals": { "invoiced": "26050.00", "received": "25400.00", "outstanding": "650.00" }
}
```

| Query | Effect |
|-------|--------|
| `search` | Sale number, customer name or customer ID |
| `status` | `quote` \| `draft` \| `finalized` \| `cancelled` |
| `shopId` | FR-11.5.1 |
| `customerId` | |
| `createdFrom`, `createdTo` | Date range, inclusive |
| `itemType` | `inventory` \| `non_inventory` — see BR-15 below |
| `createdById` | FR-00.5, the manager's "review one salesperson" filter |

### `totals` and BR-15

`totals` respects **every** applied filter. With `itemType` set they are
**apportioned** (BR-15): a mixed order contributes only the value of its matching
lines, and the received amount is **pro-rated by that line share**. A sale half
machines and half stock with everything paid contributes half its receipts to a
stock-only view.

### The created-by filter narrows, never widens

`createdById` is applied *in addition to* BR-01's scope, not instead of it. A
non-manager passing someone else's id gets **zero** sales, not theirs.

---

## `POST /api/sales`

**Permission:** `add_sale`. Customer, lines and an optional first payment in one
submission (FR-02.2).

```bash
curl -s -b $JAR -X POST $BASE/sales \
  -H 'Content-Type: application/json' \
  -d '{
    "customerId": "1",
    "shopId": "1",
    "items": [
      { "itemType": "inventory", "inventoryItemId": "1", "quantity": "3" },
      { "itemType": "non_inventory", "description": "Lathe machine XL",
        "quantity": "1", "unitPrice": "25000.00" }
    ]
  }'
```

Add `"status": "quote"` for quotation mode, and `initialPayment` to take money on
the same form.

**Line totals and the order total are calculated by the system and never
accepted from the caller.** `line_total` is a generated column; the sale total is
maintained by a trigger.

### The two line kinds (BR-04)

| `itemType` | Requires | Draws stock |
|------------|----------|-------------|
| `inventory` | `inventoryItemId` | Yes, at finalisation |
| `non_inventory` | `description` — this *is* the machine | No |

Neither may be saved without its required field. A machine line that accidentally
carried an `inventoryItemId` would be silently deducted from stock at
finalisation, so the database makes that state unrepresentable.

### Price defaulting

A stocked line with `unitPrice` omitted or zero takes **the product's current
selling price**. A *positive* entered price always wins, so a deliberate discount
survives and an empty field does not silently sell at nothing.

### Errors

| Situation | Response |
|-----------|----------|
| No lines | 400 — BR-05 |
| Machine line, no description | 400 — BR-04 |
| Stocked line, no product | 400 — BR-04 |
| Product from another shop | 409 `fk_saleitem_inventory_shop` — BR-50 |
| Customer from another shop | 409 `fk_sale_customer_shop` — BR-53 |

The last two are the database's, not the application's: `sale_items` carries its
own `shop_id` pinned by composite foreign keys to *both* its sale and its
product, so one shop can never sell another's stock by any route.

---

## `POST /api/sales/:id/convert`

**Permission:** `change_sale`. FR-02.3.1 — a quotation becomes a draft invoice in
one step, keeping its items and prices, and follows the normal flow from there.

---

## `POST /api/sales/:id/finalize`

**Permission:** `finalize_sale` — its own permission (FR-02.4.3), so the staff
who assemble orders need not be the staff who commit them.

```bash
curl -s -b $JAR -X POST $BASE/sales/1/finalize
```

```json
{
  "saleNumber": "26-08-2026-FE-0001",
  "nowLowOnStock": [
    { "partCode": "CLP-001", "partName": "Clip", "quantity": "7.000", "minimumStock": 10 }
  ],
  "sale": { "status_code": "finalized", "finalized_at": "2026-08-26T13:31:02.000Z" }
}
```

**This is irreversible.** It deducts stock, records a movement against each
product naming the sale and the user, and starts the sale counting toward revenue
and dues.

**BR-06 — availability is validated for *every* line before *any* deduction.**
Both loose units and whole boxes. If one line is short the entire finalisation is
refused and nothing changes — not even the lines that could have been filled:

```json
{
  "statusCode": 400,
  "message": "Not enough stock to finalise 26-08-2026-FE-0002. Nothing has been changed. Short: Clip (CLP-001): need 99999.000, have 77.000."
}
```

`nowLowOnStock` is FR-02.4.2 — the items that have just fallen to or below their
minimum and need reordering.

**BR-08** — a finalised sale cannot be finalised again (400).

---

## `POST /api/sales/:id/payments`

**Permission:** `add_salepayment`.

```bash
curl -s -b $JAR -X POST $BASE/sales/1/payments \
  -H 'Content-Type: application/json' \
  -d '{"amount":"5000.00","paymentDate":"2026-08-26","paymentMethodId":"1"}'
```

Any number of part-payments; each gets a unique receipt number
(`RCPT-20260826-A1B2C3`) and posts a **Credit** to the ledger automatically
(FR-08.1, BR-38).

| Rule | Response |
|------|----------|
| **BR-09** total payments may not exceed the sale value | 400 naming the balance |
| **BR-10** no payment of zero or less | 400 |
| **BR-11** no payment on a cancelled sale (a quotation or draft may take an advance) | 400 |
| **BR-62** the method must be `customer`-scoped | 400 |

`PATCH /api/sale-payments/:id` and `DELETE /api/sale-payments/:id` edit and
remove them; the ledger entry follows both (BR-40).

---

## `PATCH /api/sales/:id/discount`

FR-02.5a — the sale's one discount. `change_sale`.

PATCH, not POST: a sale has at most one discount, so sending this twice replaces
it rather than adding a second. There is no DELETE — `amount: "0"` clears it,
along with the reason and the attribution.

```bash
curl -X PATCH localhost:3000/api/sales/12/discount \
  -H 'Content-Type: application/json' -b cookies.txt \
  -d '{"amount":"200.00","reason":"Damaged packaging"}'
```

Returns the refreshed sale. `total_amount` is already **net** of the discount —
that is the amount payable, and it is what `balance_due` is measured from.
`subtotal_amount` is the line total before it:

```json
{
  "id": "12",
  "subtotal_amount": "1000.00",
  "discount_amount": "200.00",
  "total_amount": "800.00",
  "amount_paid": "0.00",
  "balance_due": "800.00",
  "discount_reason": "Damaged packaging",
  "discounted_by": "admin",
  "discounted_at": "2026-09-03T11:22:04.517Z"
}
```

A discount is **not a payment** (BR-67): `amount_paid` does not move, no receipt
number is issued, and nothing is posted to the ledger.

### Errors

| Case | Status | Message |
|------|--------|---------|
| Above the line subtotal (BR-68) | 400 | `A discount cannot exceed the 1000.00 this sale is for.` |
| Below what is already paid (BR-68) | 400 | `That discount would leave the sale below the 800.00 already paid. The most you can discount is 200.00.` |
| Sale fully settled (BR-69) | 400 | `This sale is fully paid. Its discount can no longer be changed.` |
| Cancelled sale (BR-69) | 400 | `A cancelled sale cannot be discounted.` |
| Quotation (BR-69) | 400 | `A quotation cannot be discounted. Convert it to a draft invoice first.` |
| Negative amount | 400 | `A discount cannot be negative.` |

A discount survives later line edits — adding a 500 line to a 1000 sale
discounted by 200 gives a subtotal of 1500 and a total of 1300. It does **not**
survive the sale being emptied: removing the last line clears the discount along
with the payments (FR-02.6.2), because a sale with no lines cannot carry one.

## Editing a finalised sale (FR-02.6)

**Restricted to administrators** — a manager can *see* a finalised sale but not
change its lines:

```json
{ "statusCode": 403, "message": "Editing the lines of a finalised sale is restricted to administrators." }
```

### `POST /api/sales/:id/items`

**BR-13** — stock is validated and deducted immediately, exactly as at
finalisation.

### `DELETE /api/sales/:id/items/:itemId`

**BR-12** — the stock that line consumed is **returned to inventory** and a
reversing Adjustment movement is recorded, naming the sale. Stock is never
silently lost.

**FR-02.6.2** — if this empties the sale, it reverts to draft and its payments
are deleted so no orphaned overpayment remains:

```json
{
  "revertedToDraft": true,
  "paymentsRemoved": 1,
  "sale": { "status_code": "draft", "finalized_at": null, "amount_paid": "0.00" }
}
```

> `finalized_at` is cleared deliberately. A stale timestamp on a draft would
> corrupt the FIFO ordering in BR-16, which is why the database asserts the
> biconditional: a finalised sale must have a timestamp, and only a finalised
> sale may.

---

## `DELETE /api/sales/:id`

**Permission:** `delete_sale`. **BR-14 — only draft sales may be deleted.**
Finalised, cancelled and quotation sales are not deletable through the API.

---

## Customer account and lump-sum payment

### `GET /api/customers/:id/account`

FR-03.4 — every finalised order with totals across the whole relationship, plus
the payment events showing how many invoices each was spread across.

### `GET /api/customers/:id/outstanding`

FR-03.5.1 — offer the payment action only when this is above zero.

### `POST /api/customers/:id/payments`

**Permission:** `add_customerpayment`. One lump sum, distributed by the system.

```bash
curl -s -b $JAR -X POST $BASE/customers/1/payments \
  -H 'Content-Type: application/json' \
  -d '{"amount":"19700.00","paymentDate":"2026-08-26","paymentMethodId":"1"}'
```

```json
{
  "batchRef": "CUSTPMT-20260826193301-34A9FB",
  "totalAmount": "19700.00",
  "invoicesSettled": 3,
  "allocations": [
    { "saleNumber": "26-08-2026-FE-0001", "amount": "19450.00", "receiptNumber": "RCPT-20260826-6DB69E" },
    { "saleNumber": "26-08-2026-FE-0004", "amount": "200.00",   "receiptNumber": "RCPT-20260826-28F6E0" },
    { "saleNumber": "26-08-2026-FE-0005", "amount": "50.00",    "receiptNumber": "RCPT-20260826-186DC0" }
  ]
}
```

- **BR-16** — applied **oldest finalised sale first**, ordered by finalisation
  time, until exhausted.
- **BR-17** — may not exceed the customer's total outstanding. If it would, the
  whole event is rejected and **nothing** is written.
- **BR-18** — each sale touched gets its own **real** payment row and receipt
  number, so per-invoice histories stay accurate and independently printable.
- **BR-19** — the whole event is grouped under one reference.
- **BR-20** — serialised per customer, so two simultaneous payments cannot both
  allocate against the same balance.

### `GET /api/customer-payments/:batchRef`

BR-19's combined receipt, listing every invoice settled and the amount applied to
each.

---

## Documents and exports

**FR-02.9 is built**, on `DocumentsController` (`/api/documents`), not here:
`sales/:id/invoice`, `sales/:id/statement`, `sales/:id/payments.csv`,
`payments/:id/receipt`, `orders.csv` and `orders.pdf`. Each re-applies BR-01
before rendering — a sale outside the caller's scope is missing, not forbidden.

`orders.csv` and `orders.pdf` take an optional `?customerId=`, which narrows the
history to one customer and names them in the document and the filename. It
composes with BR-01 rather than replacing it: an employee asking for one
customer's orders gets **their own** sales for that customer.
