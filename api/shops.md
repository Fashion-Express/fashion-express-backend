# Shops

FR-11. The business operates more than one shop; customers, stock and sales each
belong to exactly one (BR-49).

A shop is deliberately thin — a *scope* for other records rather than a record
with substance of its own. Two fields and a status.

**What is not shop-scoped** (FR-11.4), stated so the boundary is not guessed at:
suppliers and purchases (buying is central), bill claims (they belong to the
staff member), and the ledger (one running balance for the business). Expenses
carry an optional shop, where `NULL` means a business-wide cost.

---

## `GET /api/shops`

**Permission:** `view_shop`. Paginated at 10.

```bash
curl -s -b $JAR "$BASE/shops"
```

```json
{
  "items": [
    {
      "id": "1",
      "name": "Gulshan Branch",
      "description": "",
      "is_active": true,
      "customer_count": "4",
      "inventory_count": "2",
      "sale_count": "0",
      "staff_count": "2"
    }
  ],
  "page": 1, "pageSize": 10, "total": 1, "totalPages": 1
}
```

The counts are FR-11.2.2: *"so the consequences of deactivating one are visible
before acting"*. `staff_count` is there because a shop is also somebody's home
shop, and that blocks deletion too.

| Query | Effect |
|-------|--------|
| `page` | 1-based |
| `search` | Matches the name |
| `isActive` | `true` / `false` |

---

## `GET /api/shops/options`

Active shops, for the shop picker on every create form. **Needs no `view_shop`** —
anyone creating a customer or product must choose a shop (BR-49), so gating it
would make the day-to-day screens unusable.

```json
[{ "id": "1", "name": "Gulshan Branch" }]
```

---

## `POST /api/shops`

**Permission:** `add_shop`.

```bash
curl -s -b $JAR -X POST $BASE/shops \
  -H 'Content-Type: application/json' \
  -d '{"name":"Dhanmondi Branch","description":"Second outlet"}'
```

**BR-47 — the name is unique ignoring case.** "Gulshan Branch" and "gulshan
branch" are the same shop:

```json
{
  "statusCode": 409,
  "message": "A shop with that name already exists.",
  "constraint": "uq_shops_name_ci"
}
```

---

## `PATCH /api/shops/:id`

**Permission:** `change_shop`. Accepts `name`, `description`, `isActive`.

```bash
curl -s -b $JAR -X PATCH $BASE/shops/2 \
  -H 'Content-Type: application/json' -d '{"isActive":false}'
```

**This is how you retire a shop** (FR-11.2.3). An inactive shop disappears from
`/options` but keeps every record it holds, and continues to appear in reports.

---

## `DELETE /api/shops/:id`

**Permission:** `delete_shop`. `204` on success.

**BR-48 — a shop holding any customer, product, sale or staff account cannot be
deleted**, and the response says exactly what is in the way:

```json
{
  "statusCode": 409,
  "message": "\"Gulshan Branch\" holds 1 product(s), 2 staff account(s) and cannot be deleted. Deactivate it instead — its history stays intact and continues to appear in reports."
}
```

Deletion exists only for a shop created in error and never used. The database
enforces it with `ON DELETE RESTRICT` on all four child tables, so it holds even
from a direct `psql` session.
