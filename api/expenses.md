# Expenses

FR-06. Costs the business has paid out. Every expense posts a **Debit** to the
ledger automatically (FR-08.1, BR-38).

**BR-33 shapes this module and is worth reading first:** anyone holding the add
permission may **create** an expense, but **only managers may edit or delete
one**. Recording a cost is day-to-day work; changing one after the fact is not,
because the ledger has already moved.

---

## `GET /api/expenses`

**Permission:** `view_expense`. Paginated at 10.

```bash
curl -s -b $JAR "$BASE/expenses?month=2026-08"
```

```json
{
  "items": [
    {
      "id": "1",
      "date": "2026-08-20",
      "description": "Office electricity",
      "amount": "1500.00",
      "paid_to": "DESCO",
      "receipt_number": "U-8891",
      "category_code": "utilities",
      "category_label": "Utilities",
      "method_label": "Cash",
      "shop_id": null,
      "shop_name": null,
      "claim_id": null
    }
  ],
  "page": 1, "pageSize": 10, "total": 1, "totalPages": 1,
  "filteredTotal": "1500.00",
  "ledgerBalance": "25600.00"
}
```

FR-06.5 — `filteredTotal` is the total of everything matching the filter (not
just this page). `ledgerBalance` is the **business-wide** balance and is
deliberately *not* filtered: it is the ledger's number, not this page's.

### Filters (FR-06.4)

| Query | Effect |
|-------|--------|
| `search` | Description, payee or receipt number |
| `expenseCategoryId` | From the managed list |
| `shopId` | §10.2 — expenses may carry a shop |
| `month` | `YYYY-MM`, a whole month |
| `date` | A single day |
| `from` / `to` | An explicit range |

**Precedence: an explicit range beats a single date, which beats a month.**
Sending `month=2026-07&from=2026-08-01` is not ambiguous — the range wins.

---

## `GET /api/expenses/by-category`

FR-09.1 — expenses by category, ranked by size. `?year=2026` scopes it.

Grouped by **category id**, and the label is returned for display. Grouping by
label would re-bucket every historical expense the moment someone renamed a
category, which is exactly what the retained code exists to prevent.

---

## `GET /api/expenses/:id`

**Permission:** `view_expense`.

FR-06.6 — where an expense originated from an approved staff claim, the response
carries that provenance:

```json
{
  "id": "3",
  "date": "2026-08-18",
  "amount": "1200.00",
  "paid_to": "sales",
  "claim": {
    "id": "1",
    "description": "Client dinner",
    "bill_date": "2026-08-18",
    "approval_date": "2026-08-26",
    "submitted_by": "sales",
    "approved_by": "owner"
  }
}
```

`claim` is `null` for an expense entered directly.

---

## `POST /api/expenses`

**Permission:** `add_expense` — and *only* that. A Finance user, who is not a
manager, can create expenses all day.

```bash
curl -s -b $JAR -X POST $BASE/expenses \
  -H 'Content-Type: application/json' \
  -d '{
    "date": "2026-08-20",
    "amount": "1500.00",
    "description": "Office electricity",
    "expenseCategoryId": "2",
    "paymentMethodId": "11",
    "paidTo": "DESCO",
    "receiptNumber": "U-8891"
  }'
```

| Field | Required | Notes |
|-------|----------|-------|
| `date`, `amount`, `description` | yes | `amount` is a decimal string (NFR-01) |
| `expenseCategoryId` | yes | Every expense is classified |
| `paymentMethodId` | no | Must be `expense`-scoped (BR-62). Optional — not every expense records how it was settled |
| `paidTo`, `receiptNumber`, `notes` | no | |
| `shopId` | no | **`null` means a business-wide cost** — head office rent, the accountant's fee (§10.2) |

---

## `PATCH /api/expenses/:id` · `DELETE /api/expenses/:id`

**Permission:** `change_expense` / `delete_expense` **and manager**. A Finance
user gets a 403 here even though they created the row.

Editing the amount moves the ledger entry with it; deleting the expense removes
the entry (BR-40). The ledger balance must always equal the sum of the records
behind it.

---

## A note on the ledger reference

An expense's ledger line is keyed `EXP-{id}`, not on `receipt_number`.

FR-08.1 calls it "the expense reference", but `receipt_number` is optional and
often blank — and BR-39's duplicate protection is a **partial** unique index that
only covers rows with a non-empty reference. Keying on the expense's own id makes
every post unique, makes the rebuild idempotent, and cannot collide with a
receipt number someone happens to type.
