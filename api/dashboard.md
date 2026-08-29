# Dashboard

FR-01. The landing page after sign-in, assembled live from current records.

---

## `GET /api/dashboard`

**No permission decorator.** What you see is decided by *your* permissions inside
the endpoint, not by a gate on the route — a user with only bill-claim rights
gets a reduced view rather than a 403, because being told "no" on the landing
page immediately after signing in is a poor answer.

```bash
curl -s -b $JAR "$BASE/dashboard?shopId=1"
```

```json
{
  "reduced": false,
  "shopId": "1",
  "headline": {
    "active_employees": "3",
    "active_customers": "5",
    "inventory_items": "3",
    "low_stock_count": "1",
    "stock_value": "8450.00"
  },
  "sales": {
    "draft_count": "6",
    "quotation_count": "0",
    "finalized_count": "3",
    "finalized_today": "50600.00",
    "invoiced": "50600.00",
    "outstanding": "20150.00"
  },
  "businessWide": {
    "note": "Expenses and bill claims are not scoped to a shop, so these figures cover the whole business regardless of the shop filter.",
    "expenses_this_month": "5800.00",
    "claims_awaiting_review": "1",
    "claims_awaiting_value": "800.00"
  },
  "topProducts": [
    { "label": "Clip (CLP-001)", "item_type": "inventory", "quantity_sold": "9.000", "value_sold": "450.00" },
    { "label": "Lathe machine XL", "item_type": "non_inventory", "quantity_sold": "2.000", "value_sold": "50000.00" }
  ],
  "lowStock": [],
  "recentSales": [],
  "recentExpenses": []
}
```

### `?shopId=` and what it does *not* filter

FR-01.8 — every figure is filterable by shop, **except** expenses and bill
claims. Those are not shop-scoped (FR-11.4), so they sit in `businessWide` with
a `note` saying so.

That separation is the point: a figure that silently ignored the filter above it
would be worse than no figure. If you show a shop selector, label the
`businessWide` tiles as business-wide.

### `topProducts` (FR-01.4)

The top 10 by **quantity sold** across finalised sales, covering both stocked
products and machine lines.

Machine lines have no product to group by, so they group on **the first
meaningful line of the description** — the first non-empty one. That is what
makes repeat sales of the same machine aggregate into a single row instead of
scattering one row per sale. A description of `"Lathe machine XL\nserial 88"`
groups as `Lathe machine XL`.

### Counts vs totals

`draft_count` and `quotation_count` include drafts and quotations, because a
count of drafts is the point of that tile. **No money figure ever does** — BR-03
excludes them from every revenue and dues total in the system.

`finalized_today` is the **Asia/Dhaka** day (NFR-05). At 3am Dhaka time the UTC
date is a different day and the figure would be wrong.

---

## The reduced dashboard (FR-01.7)

A user whose only permissions are bill-related gets this instead:

```json
{
  "reduced": true,
  "reason": "Your permissions cover bill claims only, so the dashboard offers just those.",
  "actions": [
    { "label": "Submit a Bill", "path": "/api/bill-claims", "method": "POST" },
    { "label": "My Bills", "path": "/api/bill-claims", "method": "GET" }
  ],
  "myClaims": { "pending": "0", "approved": "0", "rejected": "0" }
}
```

Check `reduced` before rendering anything else — the other keys are absent.

---

## `GET /api/low-stock-count`

FR-01.6 — a low-stock count must be visible on **every page**, not only the
dashboard. This is the cheap endpoint a layout can call for that banner.

```bash
curl -s -b $JAR "$BASE/low-stock-count?shopId=1"
```

```json
{ "count": 1 }
```

BR-24 defines low stock as quantity at or below the item's *own* minimum, and
BR-52 evaluates it per shop. The partial index `idx_inventory_low_stock_shop`
exists precisely because this runs on every page load.
