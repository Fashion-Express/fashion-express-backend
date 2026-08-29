# Inventory

FR-04. Stock belongs to a **shop**, not to a shared warehouse — one product
carried by three shops is three records with three quantities, three prices and
three movement histories.

Two independent stock dimensions: loose **units** (three decimals, so part units
measure cleanly) and whole **boxes**. They are validated, deducted and *logged*
separately (BR-26).

---

## `GET /api/inventory`

**Permission:** `view_inventoryitem`. Paginated at 10.

```bash
curl -s -b $JAR "$BASE/inventory?shopId=1"
```

```json
{
  "items": [
    {
      "id": "1",
      "part_code": "CLP-002",
      "part_name": "Large clip",
      "quantity": "50.500",
      "box_count": 4,
      "purchase_price": "40.00",
      "unit_price": "75.00",
      "minimum_stock": 10,
      "is_low_stock": false,
      "stock_value": "3787.50",
      "shop_id": "1",
      "shop_name": "Gulshan Branch",
      "unit_code": "pcs",
      "unit_label": "Pieces",
      "category_id": null,
      "category_name": null,
      "supplier_id": null,
      "supplier_name": null
    }
  ],
  "page": 1, "pageSize": 10, "total": 2, "totalPages": 1,
  "summary": {
    "product_count": "2",
    "total_quantity": "55.500",
    "total_boxes": "4",
    "total_value": "4187.50",
    "low_stock_count": "1"
  }
}
```

**`summary` describes the current filter, not the current page** (FR-04.4). Filter
to one shop and the summary is that shop's; ask for low stock only and it
describes just those.

| Query | Effect |
|-------|--------|
| `page` | 1-based |
| `search` | FR-04.3 — product name, code or category |
| `shopId` | FR-11.5.1 |
| `categoryId` | |
| `lowStock` | `true` shows only items at or below their minimum |

`quantity` is a 3-decimal string and money is 2-decimal. `stock_value` is
rounded at money scale — `quantity × unit_price` naturally carries five decimals,
which would be wrong to hand back as money (NFR-01).

---

## `GET /api/inventory/options?shopId=1`

The line-item picker for a sale. **`shopId` is required**: a sale may only draw
on its own shop's stock (BR-50), and offering anything else guarantees a save the
database refuses.

---

## `GET /api/inventory/low-stock`

**BR-24 — an item is low when its quantity is at or below its own minimum.** That
one definition drives every low-stock warning in the system, and BR-52 evaluates
it per shop: an item is low when *its* quantity is low, regardless of stock held
elsewhere.

```bash
curl -s -b $JAR "$BASE/inventory/low-stock?shopId=1&limit=5"
```

Backs the five-item panel on the dashboard (FR-01.5) and the count that must
appear on every page (FR-01.6).

---

## `POST /api/inventory`

**Permission:** `add_inventoryitem`.

```bash
curl -s -b $JAR -X POST $BASE/inventory \
  -H 'Content-Type: application/json' \
  -d '{
    "partCode": "CLP-002",
    "partName": "Large clip",
    "shopId": "1",
    "unitId": "1",
    "quantity": "50.500",
    "boxCount": 4,
    "unitPrice": "75.00",
    "purchasePrice": "40.00",
    "minimumStock": 10
  }'
```

| Field | Required | Notes |
|-------|----------|-------|
| `partCode` | yes | **Unique within the shop, not globally** (BR-51) |
| `partName` | yes | |
| `shopId` | yes | BR-49 |
| `unitId` | yes | FR-04.1.2 — a quantity without a unit is meaningless |
| `categoryId`, `supplierId` | no | Both optional (FR-04.1.2) |
| `quantity` | no | Decimal string, 3dp. Defaults `0` |
| `boxCount`, `minimumStock` | no | Whole numbers |
| `purchasePrice`, `unitPrice` | no | Decimal strings, kept separate so margin stays visible (BR-22) |

**`part_code` is unique per shop.** Two shops may each stock `CLP-001` and those
are two independent records. The consequence to remember: *a product code no
longer identifies a product* — any lookup by code needs the shop too.

Creating with stock records an opening **Stock In** movement reasoned
`Initial stock`. Creating with nothing records none: a movement log should
describe movements, not creations.

---

## `PATCH /api/inventory/:id`

**Permission:** `change_inventoryitem`.

`shopId` is refused with a 400 — BR-54 fixes a record's shop at creation, and
moving stock between shops is a transfer, explicitly out of scope (§7). The
workaround is two adjustments, which leaves an auditable trail but does not link
the halves.

`partCode` *is* editable: it is unique per shop, not an immutable identifier.

### What an edit writes to the movement log

FR-04.5.1's vocabulary is deliberately asymmetric:

| Change | Recorded as | Reason |
|--------|-------------|--------|
| Quantity raised | **Stock In** | `Stock added via edit` |
| Quantity lowered | **Adjustment** | `Stock adjusted via edit` |

Stock leaving through an edit is a *correction*; stock leaving through a sale is
an *issue*, and the log has to tell them apart.

Units and boxes are evaluated separately, so one edit that raises units and
lowers boxes writes one row of each kind (BR-26). An edit that changes neither
writes nothing.

**BR-23 — stock may never go negative:**

```json
{
  "statusCode": 422,
  "message": "Stock cannot go negative — there is not enough on hand.",
  "constraint": "inventoryitem_quantity_non_negative"
}
```

---

## `GET /api/inventory/:id/movements`

FR-04.5. Paginated at **20** (RD-12), newest first.

```bash
curl -s -b $JAR "$BASE/inventory/1/movements?page=1"
```

```json
{
  "items": [
    {
      "id": "4",
      "created_at": "2026-08-26T13:11:02.000Z",
      "type_code": "adjustment",
      "type_label": "Adjustment",
      "direction": 0,
      "quantity": "20.000",
      "previous_quantity": "80.000",
      "new_quantity": "60.000",
      "box_quantity": 0,
      "previous_box_quantity": 0,
      "new_box_quantity": 0,
      "reason": "Stock adjusted via edit",
      "created_by": "owner"
    }
  ],
  "total": 4, "page": 1, "pageSize": 20
}
```

**This is read-only, and there is no write route** — BR-25: movements are
recorded automatically, never written by hand, and never edited or deleted. A
`POST` here is a 404 and always should be.

`quantity` is the **absolute** amount moved; the sign comes from the transaction
type's `direction` (`+1` in, `−1` out, `0` either). Render from `direction`
rather than comparing the code to a string (FR-12.7.2).

Each row carries only one dimension: a unit movement zeroes the box columns and
vice versa. That is what lets a five-unit movement be told from a five-box one.

---

## `DELETE /api/inventory/:id`

**Permission:** `delete_inventoryitem`. `204` on success.

**BR-27 — a product that has ever appeared on a sale cannot be deleted**, because
doing so would destroy the sale's record of what was actually shipped:

```json
{
  "statusCode": 409,
  "message": "This product appears on 3 sale line(s) and cannot be deleted — doing so would destroy the record of what was shipped."
}
```

Deleting a product does cascade to its movement history — that history describes
the product and has no meaning without it.
