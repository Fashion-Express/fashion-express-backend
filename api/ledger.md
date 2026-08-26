# Ledger

FR-08. The single append-only record of every credit and debit in the system.

**Manager-only** (FR-09.5), and **read-only**. BR-38: no user posts a ledger line
by hand — there is no `POST`, `PATCH` or `DELETE` for entries and there never
should be. Lines appear because money moved somewhere else.

| Event | Posts as | Source | Reference |
|-------|----------|--------|-----------|
| Payment received against a sale | **Credit** | `sale_payment` | The receipt number |
| Expense recorded | **Debit** | `expense` | `EXP-{id}` |
| Payment made to a supplier | **Debit** | `supplier_payment` | The receipt number |

---

## `GET /api/ledger`

**Permission:** `view_ledger` + manager. Paginated at 10, newest first.

```bash
curl -s -b $JAR "$BASE/ledger?source=expense"
```

```json
{
  "items": [
    {
      "id": "17",
      "timestamp": "2026-08-26T13:42:11.000Z",
      "entry_type": "debit",
      "entry_type_label": "Debit",
      "direction": -1,
      "source": "expense",
      "source_label": "Expense",
      "reference": "EXP-3",
      "description": "Client dinner",
      "amount": "1200.00",
      "signed_amount": "-1200.00"
    }
  ],
  "page": 1, "pageSize": 10, "total": 15, "totalPages": 2,
  "totals": { "total_credits": "30450.00", "total_debits": "4850.00", "balance": "25600.00" },
  "filtered": { "net": "-3000.00", "gross": "3000.00" }
}
```

**`totals` covers the whole ledger; `filtered` covers what you asked for.** That
split is deliberate: "the current balance" means the business's balance, and a
filtered subtotal under the same label would be a much more confusing number.

`signed_amount` is `amount × direction`, computed server-side. **Render from
`direction`, never by comparing `entry_type` to the string `"credit"`** — the
definition of a credit lives in one row of `ledger_entry_types` (FR-12.12.2),
which is the whole reason that list is a table.

| Query | Effect |
|-------|--------|
| `entryType` | `credit` \| `debit` |
| `source` | `sale_payment` \| `expense` \| `supplier_payment` \| `other` |
| `reference` | Partial match on the receipt or reference |
| `from` / `to` | Date range |

---

## `POST /api/ledger/rebuild`

**Permission:** `rebuild_ledger` + manager.

FR-08.3 — rebuild the ledger from the records behind it, with a preview that
reports what it would post before writing anything.

```bash
# preview (the default) — writes nothing
curl -s -b $JAR -X POST "$BASE/ledger/rebuild"

# actually write
curl -s -b $JAR -X POST "$BASE/ledger/rebuild?preview=false"
```

```json
{
  "preview": false,
  "posted": { "salePayments": 1, "expenses": 0, "supplierPayments": 0 },
  "alreadyPresent": 14,
  "orphaned": []
}
```

**Preview is the default.** Rebuilding writes to the financial record, so the
safe reading of an ambiguous request is "tell me what you would do". Writing
takes an explicit `preview=false`.

**It is safe to run repeatedly.** Every post is `INSERT … ON CONFLICT DO NOTHING`
over the `(source_id, reference)` unique index (BR-39), so an entry that already
exists is not written again. A rebuild *reconciles*; it cannot duplicate. Run it
twice and the second reports `posted: 0` across the board.

### `orphaned`

Ledger lines whose underlying record no longer exists.

The ledger links to its records by a **text reference, not a foreign key**
(DB_DESIGN.MD §10), so nothing at the database level guarantees the referenced
receipt still exists. Deleting a payment is supposed to remove its entry (BR-40)
and does — but a rebuild only *adds*, so it cannot repair an orphan. They are
reported rather than silently ignored, because an orphan is money in the balance
that is not in the records.

---

## What the balance should equal

```
balance = SUM(sale_payments) − SUM(supplier_purchase_payments) − SUM(expenses)
```

That identity is asserted by the test suite after every path that creates, edits
and deletes payments on both sides. If it ever fails to hold, `rebuild` with
`preview=true` is the first thing to run: it will say what is missing.
