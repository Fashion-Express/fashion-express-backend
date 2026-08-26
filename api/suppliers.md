# Suppliers, purchases and payments

FR-05. **Not shop-scoped** — buying is done centrally for the business, not per
shop (FR-11.4).

This is the first money path in the API, so two rules apply throughout that do
not appear elsewhere yet:

- **The amount due is derived, never entered** (BR-28). `paid_amount` is
  maintained by a database trigger over the payment rows, so it cannot drift.
- **Every payment posts to the ledger automatically** (BR-38), as a Debit, in the
  same transaction. Edit a payment and its ledger entry follows; delete it and
  the entry goes (BR-40).

---

## `GET /api/suppliers`

**Permission:** `view_supplier`. Paginated at 10.

```bash
curl -s -b $JAR "$BASE/suppliers?search=acme"
```

```json
{
  "items": [
    {
      "id": "1",
      "name": "Acme Metals",
      "phone": "01800000000",
      "email": "acme@example.com",
      "address": "",
      "total_purchased": "1700.00",
      "total_paid": "1250.00",
      "total_due": "450.00",
      "purchase_count": "3"
    }
  ],
  "page": 1, "pageSize": 10, "total": 1, "totalPages": 1
}
```

`search` matches name or phone (FR-05.2). The three totals are FR-05.4.

`GET /api/suppliers/options` is the picker for the inventory form's supplier
reference (FR-04.1.1) and needs no permission.

---

## `POST /api/suppliers` · `PATCH /api/suppliers/:id` · `DELETE /api/suppliers/:id`

**Permissions:** `add_supplier`, `change_supplier`, `delete_supplier`.

```bash
curl -s -b $JAR -X POST $BASE/suppliers \
  -H 'Content-Type: application/json' \
  -d '{"name":"Acme Metals","phone":"01800000000","email":"acme@example.com"}'
```

`name` and `phone` are required. Deleting a supplier **cascades** to its
purchases and their payments — that history belongs to the supplier.

---

## `GET /api/suppliers/:id/purchases`

**Permission:** `view_supplier`.

```json
[
  {
    "id": "1",
    "product_name": "Steel sheet",
    "price": "1000.00",
    "paid_amount": "350.00",
    "due": "650.00",
    "purchase_date": "2026-08-01",
    "notes": ""
  }
]
```

`product_name` is free text: a purchase is deliberately **not** linked to an
inventory item (FR-05.3).

---

## `POST /api/suppliers/:id/purchases`

**Permission:** `add_supplier`.

```bash
curl -s -b $JAR -X POST $BASE/suppliers/1/purchases \
  -H 'Content-Type: application/json' \
  -d '{
    "productName": "Steel sheet",
    "price": "1000.00",
    "purchaseDate": "2026-08-01",
    "initialPayment": "250.00",
    "initialPaymentMethodId": "9"
  }'
```

**BR-32 — an initial payment entered with the purchase may not exceed the price,
and both are saved atomically or not at all.** Send too much and *nothing* is
written — not the purchase, not the payment:

```json
{
  "statusCode": 422,
  "message": "Total payments would exceed the value of this purchase.",
  "constraint": "purchase_not_overpaid"
}
```

> The error names `supplier_purchases`, not the payment — the constraint lives on
> the purchase and the trigger is what propagates the payment into it. Match on
> the **constraint name**, never the table.

---

## `POST /api/purchases/:id/payments`

**Permission:** `add_supplierpayment`. Instalments are the norm.

```bash
curl -s -b $JAR -X POST $BASE/purchases/1/payments \
  -H 'Content-Type: application/json' \
  -d '{
    "amount": "100.00",
    "paymentDate": "2026-08-05",
    "paymentMethodId": "6",
    "referenceNumber": "LC-99881"
  }'
```

Each payment gets its own receipt number (`SPAY-20260826-A1B2C3`).

### Three rules that will reject a payment

**BR-29 — a reference number is mandatory for LC, cheque, TT and bank; cash needs
none.** Those are traceable instruments and the reference *is* the trace:

```json
{
  "statusCode": 400,
  "message": "A reference number is required for LC payments (BR-29). Only cash needs none."
}
```

This fails **closed**: any method that is not `cash` requires a reference, so a
newly added supplier method errs toward demanding a trace.

**BR-62 — the method must be `supplier`-scoped.** Fetch the picker from
`GET /api/reference/payment-methods/options?scope=supplier`; a customer method is
refused:

```json
{ "statusCode": 400, "message": "That is not a supplier payment method..." }
```

**BR-30 — a payment may not exceed the purchase's remaining due:**

```json
{ "statusCode": 400, "message": "That payment exceeds the 650.00 still due on this purchase (BR-30)." }
```

The purchase row is locked before the check, so two payments cannot race past the
same remaining balance. The `purchase_not_overpaid` constraint is the guarantee
behind that; the lock exists so the user gets a sentence instead.

---

## `PATCH /api/purchase-payments/:id` · `DELETE /api/purchase-payments/:id`

**Permission:** `add_supplierpayment`.

Editing the amount recalculates the purchase's paid figure **and updates the
ledger entry**; deleting the payment removes the entry (BR-40). The ledger
balance must always equal the sum of the records behind it.

---

## `POST /api/suppliers/:id/pay`

**Permission:** `add_supplierpayment`.

**BR-31 — pay at the supplier level and the amount is allocated oldest purchase
first, by purchase date.**

```bash
curl -s -b $JAR -X POST $BASE/suppliers/1/pay \
  -H 'Content-Type: application/json' \
  -d '{"amount":"900.00","paymentDate":"2026-08-26","paymentMethodId":"9"}'
```

```json
{
  "allocated": [
    { "purchaseId": "3", "amount": "400.00" },
    { "purchaseId": "1", "amount": "500.00" }
  ]
}
```

Each purchase touched receives its **own payment row and its own receipt
number**, so per-purchase histories stay complete and independently printable.
Each also posts its own ledger debit.

It may not exceed the supplier's total outstanding:

```json
{ "statusCode": 400, "message": "That payment exceeds the 450.00 this supplier is owed (BR-31)." }
```

The supplier row is locked first, then its purchases — parent before children.
Two simultaneous supplier payments therefore cannot both allocate against the
same balance.
