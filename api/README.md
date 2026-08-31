# Fashion Express API

One file per entity. Every command here was run against a live server and the
responses are real, not illustrative.

| File | Covers | Status |
|------|--------|--------|
| [health.md](health.md) | Liveness probe | Implemented |
| [auth.md](auth.md) | Sign in/out, sessions, passwords | Implemented |
| [users.md](users.md) | Staff accounts, user types, permissions (FR-00.6) | Implemented |
| [reference.md](reference.md) | The twelve reference lists (FR-12) | Implemented |
| [shops.md](shops.md) | Shops (FR-11) | Implemented |
| [customers.md](customers.md) | Customers (FR-03) | Implemented |
| [inventory.md](inventory.md) | Products and stock movements (FR-04) | Implemented |
| [suppliers.md](suppliers.md) | Suppliers, purchases, payments (FR-05) | Implemented |
| [sales.md](sales.md) | Sales, finalisation, payments, customer allocation (FR-02, FR-03.4/5) | Implemented |
| [expenses.md](expenses.md) | Expenses (FR-06) | Implemented |
| [bill-claims.md](bill-claims.md) | Staff reimbursement claims (FR-07) | Implemented |
| [ledger.md](ledger.md) | The ledger and its rebuild (FR-08) | Implemented |
| [dashboard.md](dashboard.md) | Dashboard and the low-stock banner (FR-01) | Implemented |
| [reports.md](reports.md) | Reports, Excel exports, printable documents (FR-09, FR-02.9) | Implemented |
| [admin.md](admin.md) | Business settings, roles, data cleanup (FR-10) | Implemented |
**Every module in REQUIREMENTS.MD is implemented.** [PLANNED.md](PLANNED.md)
records what is deliberately out of scope.

## Base URL

```
http://localhost:3000/api
```

Start the server with `npm run start:dev`. Every route below is under `/api`,
except that `/api/auth/*` is served by better-auth directly rather than by Nest.

## The one thing to get right: cookies

Authentication is a **session cookie**, not a bearer token. `POST
/api/auth/sign-in/username` returns `Set-Cookie:
better-auth.session_token=…; HttpOnly; SameSite=Lax`, and every subsequent
request must send it back.

**In Postman this works with no configuration** — Postman keeps a cookie jar per
domain and replays it automatically. Sign in once and the rest of the collection
is authenticated. If a request unexpectedly returns 401, open Postman's *Cookies*
panel (under the Send button) and check the jar for `localhost` still holds
`better-auth.session_token`.

**In curl** you have to say so explicitly: `-c jar.txt` to save, `-b jar.txt` to
send. Every example below assumes:

```bash
BASE=http://localhost:3000/api
JAR=/tmp/fe-cookies.txt
```

There is **no `Authorization` header and no CSRF token to manage.**

## The second thing to get right: `Origin` on `/api/auth/*`

Once you hold a session cookie, better-auth refuses **its own** routes unless the
request declares a trusted origin:

```json
{ "message": "Missing or null Origin", "code": "MISSING_OR_NULL_ORIGIN" }
```

That is a 403, and it will look baffling — you are signed in, and the same
request worked a moment ago before you had a cookie.

| Request | Origin needed? |
|---------|----------------|
| `POST /api/auth/sign-in/username` with no cookie yet | No |
| Any `/api/auth/*` route **once you have a cookie** | **Yes**, and it must be in the server's `TRUSTED_ORIGINS` |
| Every Nest route (`/api/me`, `/api/users`, …) | No, ever |

An untrusted value is refused too, with `INVALID_ORIGIN`.

**The Postman collection handles this for you** — a collection-level pre-request
script adds `Origin: {{origin}}` to every request. If you build requests by hand,
add the header yourself.

In curl:

```bash
ORIGIN=http://localhost:3000
curl -s -b $JAR -H "Origin: $ORIGIN" -X POST $BASE/auth/sign-out
```

`TRUSTED_ORIGINS` lives in `.env` and defaults to
`http://localhost:3000,http://localhost:5173`.

## Authorisation

Every route except `/api/health` requires a session. Beyond that, each route
names a permission, and permissions come from the signed-in user's **type**
(Owner / Manager / Finance / Employee) rather than from the account.

`GET /api/me` returns the caller's type and full permission list — the quickest
way to see why a request was refused.

Four accounts ship in a freshly seeded development database only if you create
them; there are no default logins. See [users.md](users.md) for how to make the
first one.

## Response conventions

- **Money and quantities are strings**, never JSON numbers — `"45000.50"`, not
  `45000.5`. A JSON number is a float and NFR-01 forbids floating point anywhere
  near money. Parse them with a decimal library, not `parseFloat`.
- **IDs are strings.** They are 64-bit integers in the database and would lose
  precision as JSON numbers.
- **Lists are paginated** and shaped
  `{ items, page, pageSize, total, totalPages }`.
- **Boolean query parameters take `true`/`false`** (also `1`/`0`, `yes`/`no`,
  `on`/`off`). Anything else is a 400 rather than a guess — `?isActive=maybe`
  is rejected, not silently treated as true.

## Error shapes

Validation failures collect every problem at once:

```json
{
  "message": [
    "username must be longer than or equal to 3 characters",
    "password must be longer than or equal to 8 characters"
  ],
  "error": "Bad Request",
  "statusCode": 400
}
```

A business rule enforced by the database names the constraint that refused it,
which makes support conversations concrete:

```json
{
  "statusCode": 409,
  "message": "That username is already taken.",
  "constraint": "users_username_key"
}
```

A reference to a record that does not exist is **422**, and the message names
both the thing and the field to fix:

```json
{
  "statusCode": 422,
  "message": "That shop does not exist. Check the \"shopId\" value.",
  "constraint": "customers_shop_id_fkey"
}
```

That is the opposite case from **409**, where the record exists and is still in
use — deleting it is what was refused:

```json
{
  "statusCode": 409,
  "message": "This record is still used by existing products. Deactivate it instead of deleting it.",
  "constraint": "inventory_items_unit_id_fkey"
}
```

| Status | Means |
|--------|-------|
| 400 | The request body failed validation |
| 401 | No session, or it expired — sign in again |
| 403 | Signed in, but the user's type does not grant this |
| 404 | No such record |
| 409 | A uniqueness rule refused it, or the record is still in use |
| 422 | A business rule refused it, or a reference points at nothing |
| 429 | Locked out after 5 failed sign-ins (see auth.md) |

## Postman

`fashion-express.postman_collection.json` in this folder imports the whole
surface, with `{{baseUrl}}` as a variable. Import both files:

1. **Collection** — `fashion-express.postman_collection.json`
2. **Environment** — `fashion-express.postman_environment.json`, then select it
   top-right.

Run **Auth → Sign in** first; everything else inherits the cookie.
