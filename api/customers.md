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

## Not built yet

Two parts of FR-03 need sales to exist and land in the next phase:

- **FR-03.4** the customer account view — every finalised order with total
  invoiced, received and due, plus the payment history.
- **FR-03.5** customer-level payment — one lump sum spread across outstanding
  sales oldest-first (BR-16), each sale getting its own payment row and receipt
  (BR-18), the whole event grouped under one reference (BR-19).
