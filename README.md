# Fashion Express — Backend

NestJS + PostgreSQL API for a single trading business: sales and quotations,
per-shop inventory, suppliers and purchases, expenses, staff bill claims, and
one running ledger.

The behaviour this implements is specified in **[REQUIREMENTS.MD](REQUIREMENTS.MD)**
(66 business rules) and the schema in **[DB_DESIGN.MD](DB_DESIGN.MD)**. Both are
authoritative; this README only covers running the thing.

## The one idea worth knowing before reading the code

**The money and stock rules live in the database, not in the service layer.**

Overpaying a sale, selling another shop's stock, giving a customer a staff
status, posting the same receipt to the ledger twice, driving stock negative —
each of these is refused by a constraint, not by an `if`. The service layer
still checks the ordinary cases so users get a readable message, but the
constraint is the guarantee.

Two consequences:

- **`synchronize` is off, permanently** (NFR-17). Roughly fifteen of these rules
  are composite foreign keys, `DEFERRABLE` clauses, partial indexes and
  generated columns that TypeORM cannot model. A schema sync drops what it does
  not know about, which would silently delete the enforcement. All DDL is
  hand-written in `src/database/migrations`.
- **Tests run against a real PostgreSQL.** Mocking a repository would verify
  nothing about a rule that lives in the database. See `npm run test:db`.

## Requirements

- Node 20+ (developed on 24)
- PostgreSQL 14+ (developed and verified on 18.6)

## Database setup

Create the two databases and point `.env` at them:

```bash
createdb fashion_express
createdb fashion_express_test
```

`.env` takes a standard connection string — the `postgres` superuser is fine for
local development:

```
DATABASE_URL=postgresql://postgres:yourpassword@localhost:5432/fashion_express
DATABASE_URL_TEST=postgresql://postgres:yourpassword@localhost:5432/fashion_express_test
```

`.env` is gitignored and must stay that way (NFR-12).

If you would rather not touch the system PostgreSQL at all,
`./scripts/dev-postgres.sh start` initialises a throwaway cluster under `.devdb`
on port 55432 and prints the two lines to paste. `stop`, `status` and `reset`
do what they say.

## Running

```bash
npm install
cp .env.example .env                # then set BETTER_AUTH_SECRET
openssl rand -base64 32             # ... to one of these

npm run migration:run               # applies all 15 migrations + seed data
npm run seed:admin                  # the first Owner account — see below
npm run start:dev
curl localhost:3000/api/health
```

`npm run db:reset` drops and re-applies everything.

### The first account

`AuthGuard` is global, so `POST /users` — the route that creates staff — needs a
session to reach, and on an empty database there is no user to open one with.
`npm run seed:admin` writes that first row from outside the API: an Owner
(`user_types.code = 'owner'`, the unrestricted type) with username `admin` and
password `12345678`, both overridable.

```bash
npm run seed:admin -- --username owner --password 'something-better'
npm run seed:admin -- --force --password 'rotated'   # reset an existing account
npm run seed:admin -- --help
```

Running it twice is safe — without `--force` it reports the account already
exists and writes nothing. **Change the default password before the API is
reachable from anywhere but your machine.**

## Deploying

The application is an ordinary long-lived Node server (`npm run build &&
npm run start:prod`), and that is the shape it is happiest in: one process, two
warm connection pools, a writable disk for attachments.

### Vercel

Vercel detects `src/main.ts` as the NestJS entry point and turns the whole app
into a single Function. Four things had to be true for that to work, and three
of them are already in the repository:

- **better-auth is loaded with `import()`, never `require()`.** It ships ESM
  only; this bundle is CommonJS because NestJS needs `emitDecoratorMetadata`,
  which only `tsc` emits. Node itself has allowed `require()` of ESM since
  20.19/22.12, but Vercel loads the bundle through its own `Module._load` hook,
  which refuses it — `ERR_REQUIRE_ESM`, process exit 1, every request a 500.
  `config/auth.ts` builds the instance behind `getAuth()` for this reason.
- **`bootstrap()` also runs when `VERCEL` is set.** The host *loads* the entry
  point rather than running it as the main module, then waits for something to
  listen on `PORT`; a bare `require.main === module` guard means nothing ever
  does.
- **`vercel.json` pins the function to `bom1`.** The database is in
  `ap-south-1`; the default region is `iad1`. A request here issues several
  sequential queries, so the wrong region costs a round trip across the planet
  on each one.
- **Environment variables must be set in the project** (Settings ->
  Environment Variables), because `.env` is not deployed: `DATABASE_URL`,
  `BETTER_AUTH_SECRET`, `BETTER_AUTH_URL` (the deployment's own https URL),
  `TRUSTED_ORIGINS` (the front end's origin), and `NODE_ENV=production` — which
  is what turns on secure cookies and HSTS. `BLOB_READ_WRITE_TOKEN` is not one
  of them: Vercel injects it when a Blob store is connected, which is also what
  switches attachments to it (see below).

Migrations are never applied by the application (NFR-17). Run
`npm run migration:run` against the production `DATABASE_URL` from a machine
that has it, then `npm run seed:admin` once.

### Bill-claim attachments (FR-07.2)

Uploads go to one of two places, and which one is a deployment setting rather
than a code change:

| `ATTACHMENT_STORAGE` | Where | For |
|---|---|---|
| `disk` | `storage/attachments`, outside `dist/` per NFR-11 | a server or a container with a volume |
| `blob` | a **private** Vercel Blob store, under `bill-claims/attachments/` | a serverless host |

Unset, it follows `BLOB_READ_WRITE_TOKEN`: blob when Vercel has injected one,
disk otherwise. So connecting a Blob store to the project is the whole setup —
**Storage → Create → Blob**, connect it to this project, redeploy.

Local disk is not an option on Vercel rather than a worse one: a Function's
filesystem is read-only apart from `/tmp`, and `/tmp` belongs to one instance
and is discarded with it, so the upload either fails or cannot be read back by
the next request.

Three things to know about the blob backend:

- **The blobs are private.** A public blob is readable by anyone holding its
  URL, which would put a staff member's receipt outside the permission that
  guards the claim. `GET /api/bill-claims/:id/attachment` reads the object with
  the store token and streams it, so that route stays the only way in.
- **The column did not change.** `bill_claims.attachment` holds the same
  generated `<millis>-<12 hex>.<ext>` key under both backends — disk reads it as
  a filename, blob as a pathname under the prefix. Moving between them means
  moving bytes, not rewriting rows.
- **Vercel caps a request body at 4.5 MB**, under the 10 MB the route accepts,
  and the platform refuses the larger request before the function is invoked.
  Direct client uploads (`@vercel/blob/client`) are the way past that, and they
  would need a token route here and a change on the front end.

Replacing a document or withdrawing a claim deletes the bytes behind it, under
both backends and only *after* the row stops pointing at them. The delete is
best-effort: it cannot fail an edit the user has already made, so a store that
refuses leaves an orphan and a `BillClaimsService` warning naming the key and
the claim — the only trace it would otherwise have. An approved claim keeps its
attachment, which is why `DELETE /api/bill-claims/:id` refuses those.

### What else does not survive serverless

Two more things behave differently when the app is many short-lived instances
instead of one process. They are not Vercel bugs; they are consequences of the
model.

- **The permission cache goes stale (BR-56).** `PermissionsService` caches
  grants per user type in memory and `invalidate()` clears *that instance's*
  copy. Every other warm instance keeps serving the old grants until it is
  recycled, so "the change takes effect immediately" no longer holds. A short
  TTL bounds it; a shared cache or a `SELECT` per request removes it.
- **Connections multiply.** Each instance opens its own TypeORM pool (`max: 10`)
  and better-auth pool (`max: 5`). Point `DATABASE_URL` at Supabase's
  *transaction* pooler on port 6543 rather than the session pooler on 5432, and
  lower both maxima — nothing in the code uses `LISTEN`, session-level `SET` or
  advisory locks, so transaction pooling is safe here.

One more thing to check on the front end: the session cookie is `SameSite=Lax`
(NFR-09). If the browser app is served from a different site than the API, that
cookie will not be sent with its requests. Put both behind one domain, or move
to `SameSite=None; Secure` and accept what that means for CSRF.

## Status

All seven phases are complete: every functional requirement in
`REQUIREMENTS.MD` is implemented, with 283 tests covering the business rules.
`api/PLANNED.md` records what is deliberately out of scope.

## API documentation

`api/` holds one file per entity, with curl examples that were run against a
live server rather than written from the source. It also carries a Postman
collection and environment — import both, run **Auth → Sign in**, and the rest
inherits the session cookie.

Start at [api/README.md](api/README.md); [api/PLANNED.md](api/PLANNED.md) lists
what has no routes yet, so the gap is visible rather than discovered.

## Tests

```bash
npm run test:db        # both suites below (283 tests)
npm run test:schema    # 71 constraint, trigger and error-message tests (Jest)
npm run test:e2e       # 212 API tests (node:test via ts-node)
```

Both need `DATABASE_URL_TEST` and will truncate that database.

**Why two runners.** Three constraints meet and only this split satisfies them:

1. better-auth is **ESM-only** (no CJS build), and Jest decides a module's type
   from its extension before any transform runs — so a `.mjs` dependency cannot
   load in its CommonJS registry at all. Jest is out for anything importing
   better-auth.
2. NestJS needs `emitDecoratorMetadata`, not only for dependency injection but
   for `ValidationPipe` to know which DTO class a `@Body()` refers to. esbuild
   (so `tsx`) cannot emit it, and without it request validation silently stops
   working. ts-node emits it.
3. `node --test` loads `.ts` through the ESM loader, defeating ts-node's
   CommonJS hook — but `node:test` runs fine when a file is simply *executed*.

So `scripts/test-e2e.sh` runs each e2e file directly under ts-node, one at a
time (they share a database and `loadFixture()` clears it). The SQL suites,
which import no better-auth, stay on Jest.

## Layout

```
src/
  common/      money decimals, pg-error filter, transactions and lock ordering,
               RD-01 identifier generators, pagination, query-result helpers
  config/      env validation, TypeORM DataSource, better-auth
  database/    migrations — the schema, hand-written
  modules/
    auth/      better-auth wiring, the global guard, login lockout
    users/     staff accounts (FR-00.6)
    reference/ the twelve FR-12 vocabularies, driven by one registry
    shops/     FR-11
    customers/ FR-03
    inventory/ FR-04, including the sole writer of the movement log
    suppliers/ FR-05 — purchases and payments
    sales/     FR-02 — the largest module, split four ways:
               sales / finalisation / sale-payments / customer-payments
    expenses/  FR-06
    bill-claims/ FR-07, with attachments stored outside the app path
    ledger/    FR-08 — posting, the read side, and the rebuild
    dashboard/ FR-01
    reports/   FR-09 exports and FR-02.9 documents
    admin/     FR-10 — business settings and the data-cleanup tool
test/
  schema/      constraint and trigger suites (Jest)
  e2e/         API suites (node:test)
```

### Authentication and authorisation

- **better-auth is mounted by hand** in `main.ts` (`toNodeHandler`), before the
  body parsers — it reads the raw body itself, so Nest's parser is disabled and
  the parsers are added after. It owns everything under `/api/auth`.
- **`AuthGuard` is global** (`APP_GUARD`), so FR-00.1 holds by default and a
  route opens only with `@Public()`. It resolves the session once per request
  and attaches the user, so no guard issues its own query (DB_DESIGN.MD §23.6).
- **Capability comes from the user type** (§10.3 option B):
  `@RequirePermission('finalize_sale')`, `@RequireManager()`,
  `@RequireSuperuser()`. `PermissionsService` caches the grants per *type* —
  four entries — and `invalidate()` must be called when grants change (BR-56).
- **BR-01 is deliberately not in the guard.** "A non-manager sees only the sales
  they created" is row filtering, which belongs in the query layer; a guard
  decides whether a request proceeds, not which rows it returns.

### Audit columns

Migration 016 puts `is_active`, `created_at`, `updated_at`, `created_by_id` and
`updated_by_id` on all 29 business tables. Four things to know:

- **Attribution is by foreign key, nullable.** A copied `varchar` username is
  deviation D-06 (unattributable after a rename); H-13 says the same. Nullable
  because much of this system writes itself — the ledger (BR-38), stock
  movements (BR-25), the seed migration and the rollup triggers have no acting
  user.
- **`updated_at` is set by a trigger**, `fe_touch_updated_at`, not by service
  code. Same reasoning as the §11 rollups: maintaining it in the application
  works for every path the application controls and fails for the rest, and an
  `updated_at` that only sometimes updates is worse than none.
- **`is_active` on the transactional tables is additive and unread.** The
  authoritative state of a sale is still `status_code` (RD-03) — BR-03, BR-07
  and BR-14 key on it — and a claim's is its own (RD-08). `ledger_entries` and
  `stock_histories` remain append-only; deactivating a ledger row would silently
  unbalance the books, because the balance sums every row.
- **`TRUNCATE users CASCADE` now empties the reference lists.** Every reference
  table carries `created_by_id -> users`, so the cascade reaches statuses, units,
  user_types and the rest, leaving a database nothing can be inserted into.
  Delete instead (the FKs are `ON DELETE SET NULL`) and mind the order — users
  before shops, since `users.shop_id` is RESTRICT. FR-10.3's cleanup tool
  (BR-41 … BR-44) has to reckon with the same reach.

### Two traps this codebase has already hit

- **`query()` returns two shapes.** TypeORM gives `rows` for a SELECT but
  `[rows, affectedCount]` for INSERT/UPDATE/DELETE. Read naively, an
  `INSERT … RETURNING id` yields `undefined` and a `.length === 0` check never
  fires, so a missing row becomes a silent success. Always go through
  `rowsOf` / `firstRow` / `affectedRows` in `common/sql.ts`.
- **`internalAdapter.updatePassword` does not hash.** It writes what it is
  given. `credentials.ts` hashes first; there is a regression test.
- **`@Type(() => Boolean)` inverts `"false"`.** `Boolean("false")` is `true`, so
  a query parameter written that way silently means the opposite of what was
  asked — a wrong answer rather than an error. Use `@ToBoolean()` from
  `common/to-boolean.ts`, which rejects anything it cannot parse.

## Decisions taken against the specification's open questions

| Question | Decision |
|---|---|
| §10.1 home shop | Option **B** — `users.shop_id` defaults create forms; no visibility restriction |
| §10.2 expense shop | Adopted — `expenses.shop_id` nullable, `NULL` = business-wide |
| §10.3 permissions | Option **B** — `permissions` + `user_type_permissions`, capability on the type |
| Authentication | better-auth, mapped onto `users`, Kysely adapter |

### Where the implementation departs from DB_DESIGN.MD

All deliberate, and each is commented at the point it happens:

- **No `users.password_hash`.** better-auth keeps the hash in
  `accounts.password` (scrypt, NFR-06). `users` gains `name`, `email_verified`,
  `image` and `display_username` because better-auth's schema requires them.
- **`sale_items.line_total` is a stored generated column**, not a `BEFORE`
  trigger — §11 note 4 recommends this on NestJS. The three rollup triggers
  remain; a generated column cannot aggregate across rows.
- **`stock_histories.created_by_id` is a real foreign key** (H-13, closing
  D-06), not a copied username string. There is no legacy data forcing the text.
- **`bill_claims.user_id` is `RESTRICT`, not `CASCADE`** (H-12).
- **Indexes live in the migration that creates their table** rather than in one
  index migration — they are part of the table's definition.
- Every `[H]` hardening item ships in the initial schema. This is a greenfield
  build, so the `NOT VALID`/`VALIDATE` two-step, the pre-flight integrity
  queries (§14), and the migrations in §21–§22 do not apply.

### One ordering rule the service layer must respect

`sale_not_overpaid` is a plain `CHECK` maintained by an `AFTER` trigger, so it
is evaluated per statement rather than deferred to commit. Shrinking a sale
below what has already been paid against it is refused **at the statement that
removes the line**. FR-02.6.2 already requires the payments to go with it — the
point is that within the transaction the payments must be deleted **first**.
`test/schema/derived-values.e2e-spec.ts` pins this.
