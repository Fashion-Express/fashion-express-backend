# Customers

FR-03. Every customer belongs to exactly one shop (BR-49), and that shop is
**fixed at creation** (BR-54).

---

## `GET /api/customers`

**Permission:** `view_customer`. Paginated at 10.

```bash
curl -s -b $JAR "$BASE/customers?page=1"
```

```json
{
  "items": [
    {
      "id": "1",
      "customer_id": "FE26082026-01",
      "name": "Karim Traders",
      "company": "Karim & Sons",
      "email": "",
      "phone": "01711111111",
      "address": "",
      "city": "Dhaka",
      "notes": "",
      "created_at": "2026-08-26T04:12:55.108Z",
      "status_code": "active",
      "status_label": "Active",
      "shop_id": "1",
      "shop_name": "Gulshan Branch"
    }
  ],
  "page": 1, "pageSize": 10, "total": 4, "totalPages": 1
}
```

| Query | Effect |
|-------|--------|
| `page` | 1-based |
| `search` | FR-03.3 — name, customer ID, company or phone |
| `statusCode` | `active` \| `inactive` (RD-10) |
| `shopId` | FR-11.5.1 — the shop filter |

---

## `GET /api/customers/options?shopId=1`

The customer picker for a sale form. **`shopId` is required**: a sale's customer
must belong to the sale's shop (BR-53), so offering anyone else would produce a
save the database refuses (FR-02.2.1).

```json
[{ "id": "1", "label": "Karim Traders (FE26082026-01)" }]
```

Active customers only.

---

## `POST /api/customers`

**Permission:** `add_customer`.

```bash
curl -s -b $JAR -X POST $BASE/customers \
  -H 'Content-Type: application/json' \
  -d '{
    "name": "Karim Traders",
    "phone": "01711111111",
    "shopId": "1",
    "company": "Karim & Sons",
    "city": "Dhaka"
  }'
```

`name`, `phone` and `shopId` are required; everything else is optional.

### One customer per phone number and per email address

Both are unique **across the whole business**, not within a shop — the same
person registered once in each branch is exactly the duplicate this prevents.
A repeat is refused with **409** and the answer names who already holds it, so
the existing record can be found and edited:

```json
{
  "message": "That phone number already belongs to Niren Costa (FE31082026-02). Update that customer instead of creating a second record.",
  "error": "Conflict",
  "statusCode": 409
}
```

Both fields are reported together when both are taken. Comparison ignores
surrounding spaces, and email ignores letter case, so `Orders@Acme.test` and
`orders@acme.test` are one mailbox. Values are stored trimmed.

`email` stays optional and blank is never a duplicate of blank; `PATCH` applies
the same rule, excluding the customer's own row so re-saving a record is safe.

### The customer number

`customer_id` is issued here and **never accepted from the caller** (FR-03.2).
Format `FE` + `DDMMYYYY` + a serial: `FE26082026-01`.

The serial is **continuous** — it does not restart daily, monthly or annually
(BR-46). The date is when the record was made; the serial is independent of it,
so the fourth customer ever created is `-04` no matter what day it is.

It is also **globally unique, not per shop**: a customer number identifies one
party to the business, and two shops issuing the same one would make every
receipt ambiguous.

It is drawn inside the transaction that inserts the row, so a rollback returns
the number rather than leaving a gap.

---

## `PATCH /api/customers/:id`

**Permission:** `change_customer`.

```bash
curl -s -b $JAR -X PATCH $BASE/customers/1 \
  -H 'Content-Type: application/json' -d '{"city":"Chattogram"}'
```

**Two fields are refused with a 400** rather than ignored:

| Field | Why |
|-------|-----|
| `customerId` | Issued once, immutable (FR-03.2, BR-45) |
| `shopId` | **BR-54** — a record's shop is fixed at creation. Their sales are scoped to the same shop (BR-53) and would be left behind |

Retiring a customer is `{"statusCode":"inactive"}`.

---

## `GET /api/customers/:id/deletion-impact`

**Permission:** `delete_customer`.

FR-03.6.1 — call this **before** offering a Delete button. Deleting a customer
cascades to their sales, line items, payments, payment batches and allocations
(BR-21): no orphaned financial record may survive its customer.

```bash
curl -s -b $JAR $BASE/customers/1/deletion-impact
```

```json
{
  "customer": { "id": "1", "customer_id": "FE26082026-01", "name": "Karim Traders" },
  "sales": 3,
  "salePayments": 5,
  "paymentBatches": 1,
  "totalInvoiced": "45000.00",
  "totalReceived": "30000.00"
}
```

`totalInvoiced` and `totalReceived` cover **finalised** sales only — drafts and
quotations are excluded from every total in the system (BR-03).

---

## `DELETE /api/customers/:id`

**Permission:** `delete_customer`. `204` on success.

Irreversible, and it takes the whole financial history of that customer with it.
Show `deletion-impact` first and make the user acknowledge the loss.

---

## FR-03.4 / FR-03.5 — built, and served from the sales module

Both live on `SalesController`, because they read the sales tables:

- `GET /api/customers/:id/account` — **FR-03.4**, the account view: the customer,
  the finalised totals (`invoiced`, `received`, `due`, `order_count`), every
  finalised `order`, and the `paymentEvents` with how many invoices each settled.
  It does **not** embed each order's line items; those are `GET /api/sales/:id/items`.
- `GET /api/customers/:id/outstanding` — **FR-03.5.1**, offer the payment action
  only when this is above zero.
- `POST /api/customers/:id/payments` — **FR-03.5**, one lump sum spread
  oldest-first (BR-16), each sale getting its own payment row and receipt
  (BR-18), the whole event grouped under one reference (BR-19).
- `GET /api/customer-payments/:batchRef` — BR-19's combined receipt. Keyed on a
  globally unique reference and **not** customer-scoped: a caller showing it
  under a customer must check `customer_number` itself.
