# Users — staff accounts

FR-00.6. A staff member and a login are the same record: employment details and
credentials live on one row.

**There is no privilege flag on an account.** What someone may do comes from
their **user type** (Owner / Manager / Finance / Employee), and changing what a
type confers changes it for everyone holding it, immediately (BR-56).

---

## Creating the first account

There is no default login and sign-up is disabled, so the first account cannot
be made through the API. Create it once from the project root:

```bash
cat > seed-admin.tmp.ts <<'TS'
import { authPool } from './src/config/auth-pool';
import { createCredential } from './src/modules/auth/credentials';
import { employeeId } from './src/common/identifiers';

const [, , username, password, typeCode] = process.argv;

async function main() {
  const { rows } = await authPool.query(
    `INSERT INTO users (username, display_username, name, email, employee_id,
                        user_type_id, status_id, shop_id)
     SELECT lower($1), $1, $2, $3, $4,
            (SELECT id FROM user_types WHERE code = $5),
            (SELECT id FROM statuses WHERE scope='user' AND code='active'),
            (SELECT id FROM shops ORDER BY id LIMIT 1)
     RETURNING id::text`,
    [username, username, `${username}@fashionexpress.test`, employeeId(), typeCode],
  );
  await createCredential(rows[0].id, password);
  console.log(`created ${username} (${typeCode}) id=${rows[0].id}`);
  await authPool.end();
}
main().catch((e) => { console.error(e.message); process.exit(1); });
TS

npx ts-node -T seed-admin.tmp.ts owner Owner-Pass-123 owner
rm seed-admin.tmp.ts
```

A shop must exist first, since the script assigns one:

```bash
psql -d fashion_express -c "INSERT INTO shops (name) VALUES ('Gulshan Branch')"
```

Every account after that is made through `POST /api/users`.

---

## `GET /api/users`

**Permission:** `view_user`.

```bash
curl -s -b $JAR "$BASE/users?page=1"
```

```json
{
  "items": [
    {
      "id": "4",
      "username": "nadia",
      "name": "Nadia Islam",
      "email": "",
      "employee_id": "EMP-D9B4A959",
      "phone": "01711000000",
      "salary": "45000.50",
      "join_date": "2026-01-15",
      "is_active": true,
      "status_code": "active",
      "status_label": "Active",
      "user_type_id": "2",
      "user_type_code": "manager",
      "user_type_label": "Manager",
      "job_position": null,
      "department": null,
      "shop_id": null,
      "shop_name": null
    }
  ],
  "page": 1,
  "pageSize": 10,
  "total": 3,
  "totalPages": 1
}
```

`salary` is a **string** — see the note on money in [README.md](README.md).

### Filters

| Query | Effect |
|-------|--------|
| `page` | 1-based. Page size is fixed at 10 (RD-12) |
| `search` | Matches username, name, employee ID or email, case-insensitively |
| `statusCode` | `active` \| `inactive` \| `on_leave` |
| `userTypeId` | Numeric id from `GET /api/users/types` |
| `shopId` | Numeric shop id |

```bash
curl -s -b $JAR "$BASE/users?search=nad&statusCode=active"
curl -s -b $JAR "$BASE/users?userTypeId=4&page=2"
```

`status_code` and `is_active` answer different questions and both appear: the
status is the person's employment state (FR-00.7), while `is_active` says whether
the account may authenticate at all. Suspending an Owner does not stop them being
an Owner.

---

## `GET /api/users/:id`

**Permission:** `view_user`. Same row shape as a list item.

```bash
curl -s -b $JAR $BASE/users/4
```

404 if there is no such account.

---

## `POST /api/users`

**Permission:** `add_user`.

Creates the account and its credential in **one transaction** — an account
nobody can sign in to is not a usable half-result.

```bash
curl -s -b $JAR -X POST $BASE/users \
  -H 'Content-Type: application/json' \
  -d '{
    "username": "docdemo",
    "password": "Doc-Demo-Pass-1",
    "name": "Doc Demo",
    "userTypeId": "4",
    "phone": "01712345678",
    "salary": "32000.00",
    "joinDate": "2026-03-01",
    "statusCode": "active",
    "shopId": "1"
  }'
```

```json
{
  "id": "5",
  "username": "docdemo",
  "name": "Doc Demo",
  "employee_id": "EMP-F183072D",
  "phone": "01712345678",
  "salary": "32000.00",
  "join_date": "2026-03-01",
  "is_active": true,
  "status_code": "active",
  "user_type_code": "employee",
  "shop_id": "1",
  "shop_name": "Gulshan Branch"
}
```

The new account can sign in immediately.

### Fields

| Field | Required | Notes |
|-------|----------|-------|
| `username` | yes | 3–30 chars, `A–Z a–z 0–9 . _ -`. Stored lower-cased; the typed form is kept for display |
| `password` | yes | 8 characters minimum |
| `name` | yes | Display name |
| `userTypeId` | yes | BR-57 — every account has exactly one type |
| `email` | no | Case-insensitively unique when present; may be omitted |
| `firstName`, `lastName`, `phone`, `address`, `notes` | no | |
| `salary` | no | **Decimal string**, e.g. `"32000.00"`. A JSON number would be a float |
| `joinDate` | no | `YYYY-MM-DD` |
| `jobPositionId`, `departmentId` | no | From the managed lists (FR-12.2.2, optional) |
| `shopId` | no | Home shop — defaults create forms, does not limit visibility |
| `statusCode` | no | `active` (default) \| `inactive` \| `on_leave` |

**`employeeId` is not accepted.** It is generated as `EMP-XXXXXXXX` and is never
editable (FR-00.8). Sending it is a 400, not a silent ignore.

### Failures

| Situation | Response |
|-----------|----------|
| Username taken | 409 `That username is already taken.` (`users_username_key`) |
| Email already used | 409 `That email address is already registered.` |
| Password too short, name missing, no `userTypeId` | 400 with every problem listed |
| Unknown field (`employeeId`, `isSuperuser`, …) | 400 |

A duplicate username rolls the **whole** thing back — no orphan credential is
left in `accounts`.

---

## `PATCH /api/users/:id`

**Permission:** `change_user`. Send only what changes.

```bash
curl -s -b $JAR -X PATCH $BASE/users/5 \
  -H 'Content-Type: application/json' \
  -d '{"phone":"01799999999","statusCode":"on_leave"}'
```

```json
{
  "id": "5",
  "username": "docdemo",
  "phone": "01799999999",
  "status_code": "on_leave",
  "status_label": "On Leave"
}
```

Accepts every create field except `username` and `password`, plus `isActive`.

**What it will not accept, and why each is a 400 rather than an ignore:**

| Field | Reason |
|-------|--------|
| `username` | An immutable identifier |
| `employeeId` | Generated once, never editable (FR-00.8, BR-45) |
| `isSuperuser`, `isManager` | These columns do not exist. Privilege comes from the type — to promote someone, change their `userTypeId` |

Retiring someone is `{"statusCode":"inactive"}` or `{"isActive":false}`, not
deletion. Only accounts whose status is `active` count toward the "active
employees" figure on the dashboard.

> **Do not do this to your own account while testing.** Only an `active` account
> may authenticate, so setting your own status to `inactive` or `on_leave` — or
> `isActive: false` — ends your session on the very next request and every call
> starts returning 401. Recovering means going into the database:
>
> ```bash
> psql -d fashion_express -c "UPDATE users SET is_active = true,
>   status_id = (SELECT id FROM statuses WHERE scope='user' AND code='active')
>   WHERE username = 'owner'"
> ```

---

## `POST /api/users/:id/password`

Sets a password without knowing the old one.

**Permission:** `change_user` — **except** that anyone may change their *own*,
which is why this is checked in the handler rather than by a decorator: it
depends on the value of `:id`.

```bash
curl -s -b $JAR -X POST $BASE/users/5/password \
  -H 'Content-Type: application/json' \
  -d '{"password":"Changed-Pass-99"}'
```

`204 No Content`. Changing someone else's without `change_user` is 403.

For a user changing their own password *and* confirming the current one, prefer
`POST /api/auth/change-password` (see [auth.md](auth.md)).

---

## `DELETE /api/users/:id`

**Permission:** `delete_user` **and** an unrestricted (superuser) type.

```bash
curl -s -b $JAR -X DELETE $BASE/users/5 -w '%{http_code}\n'
```

`204 No Content`.

**Deletion is rarely the right action.** `bill_claims.user_id` is `RESTRICT`, so
anyone who has ever submitted a claim cannot be deleted at all and the database
will say so with a 409. Deactivating is what preserves history:

```bash
curl -s -b $JAR -X PATCH $BASE/users/5 \
  -H 'Content-Type: application/json' -d '{"isActive":false}'
```

Deleting your own account is refused with a 400.

Sales survive: `created_by_id` is `ON DELETE SET NULL`, so the sale remains and
only the attribution is lost.

---

## `GET /api/users/types`

The four user types, for create and edit forms.

**Permission:** `view_user`.

```bash
curl -s -b $JAR $BASE/users/types
```

```json
[
  {
    "id": "1",
    "code": "owner",
    "label": "Owner",
    "description": "Business owner. Unrestricted access.",
    "is_superuser": true,
    "is_manager": true
  },
  { "id": "2", "code": "manager",  "label": "Manager",  "is_superuser": false, "is_manager": true },
  { "id": "3", "code": "finance",  "label": "Finance",  "is_superuser": false, "is_manager": false },
  { "id": "4", "code": "employee", "label": "Employee", "is_superuser": false, "is_manager": false }
]
```

`label` is editable by the business; `code` is fixed and is what application
logic keys on (BR-59). Finance confers no elevated privilege — it classifies
staff and holds permissions.

---

## `GET /api/users/types/:id/permissions`

What a type grants, and the full catalogue to choose from.

**Permission:** `manage_referencedata`.

```bash
curl -s -b $JAR $BASE/users/types/4/permissions
```

```json
{
  "granted": ["add_customer", "add_sale", "add_salepayment", "change_sale"],
  "catalogue": [
    { "id": "42", "codename": "change_businesssettings", "label": "Configure business details", "module": "admin" },
    { "id": "43", "codename": "clean_data", "label": "Run the data cleanup tool", "module": "admin" }
  ]
}
```

`catalogue` is the whole set of 57 permissions, grouped by `module` for display.

The `menu` module holds one entry per sidebar item (FR-00.2 mechanism 2). A menu
permission decides only what is DRAWN — every page keeps its own guard, so
removing one hides a link without revoking access to the URL.

404 if there is no such type — an unknown id used to answer with an empty
`granted`, which reads as a real role granting nothing.

> **`PATCH /api/users/:id` refuses to change your own `userTypeId`** (403).
> Privilege comes from the type (BR-56), so re-pointing your own account at
> another type is changing your own privilege — and paired with the ability to
> create a type it was a route from manager to administrator. It refuses for
> everyone, an administrator included: demoting yourself is the one move with no
> way back.

## `PUT /api/users/types/:id/permissions`

FR-00.4 — replace what a role grants. **Permission:** administrator
(`@RequireSuperuser`) **plus** `manage_referencedata`.

```bash
curl -s -b $JAR -X PUT $BASE/users/types/4/permissions \
  -H 'Content-Type: application/json' \
  -d '{"permissions":["view_sale","add_sale","view_customer"]}'
```

The whole set is replaced, not merged: the screen submits a complete picture of
what the role should confer, so two administrators editing at once cannot
silently combine into a state neither chose. An empty array strips the role.

Answers the same shape as the `GET` above.

| Rule | Response |
|------|----------|
| Not an administrator (a manager is not enough) | 403 |
| `ENABLE_ROLE_EDITING` is not `true` | 403 naming the variable |
| The type is **unrestricted** (`is_superuser`) | 403 — it passes every check anyway, so editing its list would change nothing while appearing to |
| The type is the caller's **own** | 403 |
| A codename that is not in the catalogue | 400 naming it — never a silent drop |
| No such type | 404 |

**Why it is off by default.** Editing what a role confers is privilege
escalation, so it takes the same shape as the cleanup tool (BR-42): a deployment
turns it on deliberately.

**The cache.** The permission set is cached per user type
(`PermissionsService`), so this endpoint drops that type's entry **after** the
transaction commits — BR-56 requires the change to reach every holder
immediately, and an e2e test asserts a live session sees it with no restart. The
cache is per process: behind more than one API instance, only the instance that
served the write clears its copy.

`GET /api/users/types/grants-info` reports `{ enabled, safeguards }` so a client
can say why the screen is read-only instead of discovering it by failing a save.
