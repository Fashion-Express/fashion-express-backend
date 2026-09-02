# Reference data

FR-12. Twelve business-managed vocabularies, replacing what used to be free text
typed into every record or a fixed list buried in the source.

One set of routes serves all twelve. The list name in the URL is looked up in a
registry — an unknown name is a 404, never a table read.

**Reads need only a session; writes need `manage_referencedata`.** Managing these
lists is administrative (FR-12.5.1), but *reading* them is not: a salesperson
creating a product needs the units picker.

---

## The three tiers

The lists do not all behave the same, and the difference is the whole of FR-12.5.

| Tier | Lists | What you may do |
|------|-------|-----------------|
| **named** | job positions, departments, product categories | Full CRUD. A `name`, and nothing to keep stable — no logic is keyed on them |
| **coded** | units, expense categories, statuses, payment methods, item types, user types | Full CRUD. A stable `code` that logic and history key on, plus a freely editable `label` |
| **structural** | stock movement types, ledger entry types, ledger sources | **Label editing only.** No create, no delete, no deactivate |

Structural lists are closed because the system is the only writer of the records
that use them (BR-61, BR-66) — an entry nobody can write would sit in the list
for ever without appearing on a single record.

**On every list, the `code` is fixed once created (BR-59).** Renaming *Pieces* to
*Units* is safe; changing `pcs` is not, because application logic and every
historical row are keyed on it. There is no update path for it anywhere.

---

## `GET /api/reference`

The catalogue, with each list's capabilities. Draw the admin screens from this
rather than hard-coding which three lists are structural (FR-12.5.2).

```bash
curl -s -b $JAR $BASE/reference
```

```json
[
  {
    "slug": "units",
    "label": "Units of measure",
    "kind": "coded",
    "scopes": null,
    "note": "Extensible without a code change. Unit is required on every product.",
    "create": true,
    "delete": true,
    "deactivate": true,
    "editableFields": ["label", "sortOrder", "isActive"]
  },
  {
    "slug": "ledger-entry-types",
    "kind": "structural",
    "create": false,
    "delete": false,
    "deactivate": false,
    "editableFields": ["label"]
  }
]
```

`code` never appears in `editableFields`, on any list.

### The twelve slugs

| Slug | Tier | Scoped by |
|------|------|-----------|
| `job-positions` | named | |
| `departments` | named | |
| `categories` | named | |
| `units` | coded | |
| `expense-categories` | coded | |
| `item-types` | coded | |
| `user-types` | coded | |
| `statuses` | coded | `user` \| `customer` \| `sale` \| `claim` |
| `payment-methods` | coded | `customer` \| `supplier` \| `expense` |
| `transaction-types` | structural | |
| `ledger-entry-types` | structural | |
| `ledger-sources` | structural | |

---

## `GET /api/reference/:list`

Paginated at **25** (RD-12). Returns **every** entry, active or not — the
administration screen needs to see what it has retired.

```bash
curl -s -b $JAR "$BASE/reference/units"
```

```json
{
  "items": [
    { "id": "1", "code": "pcs", "label": "Pieces", "sort_order": 1, "is_active": true },
    { "id": "2", "code": "box", "label": "Box", "sort_order": 2, "is_active": true }
  ],
  "page": 1,
  "pageSize": 25,
  "total": 5,
  "totalPages": 1
}
```

| Query | Effect |
|-------|--------|
| `page` | 1-based |
| `search` | Matches `name`, or `code`/`label` on a coded list |
| `scope` | Scoped lists only. An unknown scope is a 400 |
| `isActive` | `true` / `false`. Omit for everything |

```bash
curl -s -b $JAR "$BASE/reference/statuses?scope=claim"
curl -s -b $JAR "$BASE/reference/units?search=kilo&isActive=true"
```

---

## `GET /api/reference/:list/options`

**The feed a dropdown should use.** Active entries only, unpaginated, ordered.

```bash
curl -s -b $JAR "$BASE/reference/payment-methods/options?scope=supplier"
```

```json
[
  { "id": "6",  "code": "lc",    "label": "LC",     "scope": "supplier", "sort_order": 1, "is_active": true },
  { "id": "7",  "code": "check", "label": "Cheque", "scope": "supplier", "sort_order": 2, "is_active": true }
]
```

**A scoped list requires `?scope=`** — a 400 otherwise:

```json
{ "message": "\"payment-methods\" is scoped. Pass ?scope= one of: customer, supplier, expense." }
```

That is deliberate. An unfiltered picker would offer the supplier-only `lc` on a
customer receipt, the database would then refuse the save (BR-62), and the user
would get a confusing error for something the UI should never have shown.

> **Use `/options` for pickers and `/:list` for screens.** Inactive entries are
> hidden from dropdowns but must *not* be hidden from reads — an item whose
> category was deactivated still has to display that category. Filtering
> `is_active` in the wrong place makes existing records look broken.

---

## `GET /api/reference/:list/:id/usage`

What breaks if this entry is retired. Ask before offering a delete button.

```bash
curl -s -b $JAR $BASE/reference/units/1/usage
```

```json
{ "total": 2, "byTable": { "inventory_items.unit_id": 2 } }
```

Referencing tables are discovered from the database catalogue, so a new foreign
key is counted without anyone remembering to update a list.

---

## `POST /api/reference/:list`

**Permission:** `manage_referencedata`.

```bash
# coded list
curl -s -b $JAR -X POST $BASE/reference/units \
  -H 'Content-Type: application/json' \
  -d '{"code":"sqft","label":"Square Feet","sortOrder":6}'

# named list
curl -s -b $JAR -X POST $BASE/reference/departments \
  -H 'Content-Type: application/json' -d '{"name":"Warehouse"}'

# scoped list
curl -s -b $JAR -X POST $BASE/reference/payment-methods \
  -H 'Content-Type: application/json' \
  -d '{"code":"mobile","label":"Mobile banking","scope":"supplier"}'
```

```json
{ "id": "6", "code": "sqft", "label": "Square Feet", "sort_order": 6, "is_active": true }
```

| Field | When |
|-------|------|
| `code` + `label` | Coded lists. `code` must match `^[a-z][a-z0-9_]*$` |
| `name` | Named lists |
| `scope` | Required on `statuses` and `payment-methods`, refused elsewhere |
| `description` | `categories` and `user-types` only |
| `sortOrder` | Where the list has one |
| `isSuperuser`, `isManager` | `user-types` only |

### Failures

| Situation | Response |
|-----------|----------|
| Structural list | 400 — "entries cannot be added" |
| Duplicate code | 409 naming the constraint |
| Code with spaces or capitals | 400, before it reaches the database |
| Missing `scope` on a scoped list | 400 listing the valid scopes |

### Two creates that are allowed but reach nothing

Both are deliberate, and both are documented in the requirement rather than
being oversights:

- **A third `item-types` entry** is accepted here and then **refused at the point
  of use** (FR-12.8.4). An item type is not a label but a discriminator between
  two differently *shaped* records — one drawing on stock, one free text — so a
  third kind must be built, not listed.
- **A fourth `statuses` entry under `claim`** is the same story (FR-12.11.2): a
  claim state carries obligations, and a claim holding an unknown one is
  rejected outright. Under `sale`, a new status is accepted and simply never
  reached (FR-12.8.3).

A **new supplier payment method** is genuinely usable, and fails safe: BR-29
exempts `cash` alone, so any unfamiliar code requires a reference number.

---

## `PATCH /api/reference/:list/:id`

**Permission:** `manage_referencedata`.

```bash
curl -s -b $JAR -X PATCH $BASE/reference/units/1 \
  -H 'Content-Type: application/json' -d '{"label":"Units"}'
```

Sending `code` or `scope` is a **400**, not a silent ignore:

```json
{ "message": ["property code should not exist"], "statusCode": 400 }
```

A code is keyed on by logic and history (BR-59); a scope is what keeps four
independent vocabularies apart, and moving an entry between them would re-file
every record using it.

### Deactivating — the supported way to retire an entry

```bash
curl -s -b $JAR -X PATCH $BASE/reference/units/6 \
  -H 'Content-Type: application/json' -d '{"isActive":false}'
```

The entry leaves every picker; every record already using it keeps its meaning.

### On a structural list, only `label` is accepted

```bash
curl -s -b $JAR -X PATCH $BASE/reference/ledger-entry-types/1 \
  -H 'Content-Type: application/json' -d '{"isActive":false}'
```

```json
{
  "message": "\"Ledger entry types\" is a structural list: only the label may be edited. Refused: isActive.",
  "statusCode": 400
}
```

Retiring `debit` is not something the business can sensibly do — every ledger
writer targets one of these entries, and the running balance sums them all.

`direction` on movement types and ledger entry types is read-only for the same
reason: it is the arithmetic that defines the balance and the `+`/`−` sign in the
movement history.

---

## `DELETE /api/reference/:list/:id`

**Permission:** `manage_referencedata`. `204 No Content` on success.

```bash
curl -s -b $JAR -X DELETE $BASE/reference/units/6 -w '%{http_code}\n'
```

**BR-60 — an entry in use cannot be deleted:**

```json
{
  "message": "That entry is used by 2 record(s) and cannot be deleted. Deactivate it instead — it will disappear from selection lists while every existing record keeps its meaning.",
  "statusCode": 409
}
```

The check is a courtesy; the guarantee is `ON DELETE RESTRICT` on every
reference, which refuses the delete even from a direct `psql` session.

Structural lists refuse deletion outright with a 400.

---

## `GET /api/reference/:list/:id`

A single entry, in the same shape as a list item. 404 if there is none.

---

## A note on `user-types`

`user-types` is a reference list like the others, but editing it changes what
people may do. `isSuperuser` and `isManager` are the privilege the type confers
(FR-12.1.2), and that privilege is read from the type on **every request**
(BR-56) — so changing a flag changes it for every holder immediately, with no
cached copy to go stale.

`GET /api/users/types` remains the picker for the staff forms; it returns the
same rows without needing `manage_referencedata`.

**Writing `isSuperuser` or `isManager` is restricted to administrators**, on
create and on update alike, and is the one place this module asks for more than
`manage_referencedata`. Setting them is not editing a lookup list, it is handing
out privilege: a manager holds both `manage_referencedata` and `change_user`, so
without this they could create an unrestricted type and point their own account
at it. The other half of that door is `PATCH /api/users/:id`, which refuses to
change the caller's own `userTypeId` — see [users.md](users.md).

Deleting a user type counts the **accounts** holding it, not its permission
grants: those are part of the type and the foreign key cascades them away with
it. A role nobody holds is deletable however many permissions it carries.
