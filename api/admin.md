# Administration

FR-10. Business details, the role groups, and the data-cleanup tool.

---

## `GET /api/admin/business-settings`

**Readable by any signed-in user** — every printed invoice and receipt needs
these, and the client renders the letterhead.

```json
{
  "id": "1",
  "name": "Fashion Express Ltd",
  "address": "12 Gulshan Ave, Dhaka",
  "phone": "+880 1700 000000",
  "email": "hello@fashionexpress.test",
  "logo": null,
  "invoice_footer": "Thank you for your business."
}
```

## `PATCH /api/admin/business-settings`

**Permission:** `change_businesssettings` + manager.

FR-10.1 — these appear across the interface and on **every** printed invoice and
receipt. Change them once; every future document follows.

It is a singleton row, enforced by `CHECK (id = 1)`: one business, one
letterhead, and no way to end up with two and no way to say which is right.

---

## `GET /api/admin/roles`

**Permission:** `view_user` + manager. FR-10.2 — the four role groups with the
number of permissions each carries and how many accounts hold it.

```json
[
  { "code": "owner", "label": "Owner", "is_superuser": true, "is_manager": true,
    "permission_count": "50", "account_count": "1" }
]
```

`PATCH /api/reference/user-types/:id` edits a type's label, description, sort
order and privilege flags — see [reference.md](reference.md). **The grants
themselves are `PUT /api/users/types/:id/permissions`** (FR-00.4), which is
administrator-only and off unless `ENABLE_ROLE_EDITING=true`; see
[users.md](users.md). Either way, changing what a type confers changes it for
every holder immediately (BR-56).

---

## The data cleanup tool (FR-10.3)

> **This deletes business data irreversibly.** It exists to reset a test system.
> Four independent safeguards stand in front of it, and all four apply.

### `GET /api/admin/cleanup`

**Permission:** `clean_data` + **superuser**. Reports whether the tool is
enabled, what it can clear, and the exact phrases it will demand.

```json
{
  "enabled": true,
  "targets": [{ "target": "sales", "tables": ["customer_payment_allocations", "..."] }],
  "confirmationPhrase": "DELETE ALL SELECTED DATA",
  "includeAdminsPhrase": "YES REMOVE ADMINISTRATOR ACCOUNTS",
  "safeguards": ["Restricted to administrators.", "..."]
}
```

### The four safeguards

| | Rule | How |
|---|------|-----|
| **BR-41** | Superusers only | Route decorator *and* a re-check in the service — the one operation where a missed guard cannot be undone |
| **BR-42** | Off by default in production | `ENABLE_DATA_CLEANUP=true` must be set deliberately. The default is **off**; a deployment that forgets gets the safe answer |
| **BR-43** | An exact phrase, and a preview | Without `confirmation` this **previews and writes nothing**. A near-miss (`"delete all selected data"`) is still a preview, with an error explaining why |
| **BR-44** | Administrators preserved | Administrator accounts survive unless the **second, different** phrase is given. Your own account is *never* deleted, even then |

The two phrases differ on purpose. If they were the same string, pasting the
first one twice would defeat the protection the second exists to provide.

### `POST /api/admin/cleanup`

```bash
# preview — writes nothing
curl -s -b $JAR -X POST $BASE/admin/cleanup \
  -H 'Content-Type: application/json' \
  -d '{"targets":["expenses","billClaims"]}'

# actually delete
curl -s -b $JAR -X POST $BASE/admin/cleanup \
  -H 'Content-Type: application/json' \
  -d '{"targets":["expenses","billClaims"],"confirmation":"DELETE ALL SELECTED DATA"}'
```

```json
{
  "preview": false,
  "targets": ["expenses", "billClaims"],
  "removed": { "bill_claims": 5, "expenses": 5 },
  "totalRows": 10,
  "protections": [
    "Your own account (owner) is never deleted.",
    "Administrator accounts are preserved."
  ]
}
```

Targets: `sales`, `customers`, `inventory`, `suppliers`, `expenses`,
`billClaims`, `ledger`, `users`.

### Selections are refused, never widened

Some targets cannot be cleared alone, because the database would reject the
operation part-way through:

```json
{
  "statusCode": 400,
  "message": "That selection would be refused by the database part-way through. \"expenses\" also requires \"billClaims\". Add them to the selection, or clear less — nothing is widened for you, because a destructive tool must not remove more than was asked."
}
```

| Target | Also requires | Why |
|--------|---------------|-----|
| `expenses` | `billClaims` | Deleting an expense nulls `bill_claims.expense_id`, leaving an **approved** claim with no expense — which BR-36's constraint forbids |
| `users` | `billClaims` | `bill_claims.user_id` is RESTRICT (H-12) |
| `inventory` | `sales` | `sale_items.inventory_item_id` is RESTRICT (BR-27) |
| `suppliers` | `inventory` | `inventory_items.supplier_id` is RESTRICT (BR-60) |
| `customers` | `sales` | Deleting a customer cascades to their sales (BR-21), so the count would otherwise under-report |

The tool refuses rather than quietly adding the missing target. A destructive
operation must never remove more than was asked for.

### The ledger warning

Clearing money records without `ledger` in the selection leaves **orphans** —
ledger lines whose underlying record is gone, which is money in the balance that
is not in the records:

```json
{
  "ledgerWarning": "The ledger is not in this selection, so its 17 entries will be left referring to records that no longer exist. ..."
}
```

The tool does not fix this for you, for the same reason it does not widen the
selection. `POST /api/ledger/rebuild` reports the same orphans afterwards — but
a rebuild only *adds*, so it cannot repair them.
