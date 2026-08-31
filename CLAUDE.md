# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A NestJS + PostgreSQL backend for a single trading business: sales and quotations,
per-shop inventory, suppliers, expenses, staff reimbursement claims, and one running
ledger.

**`REQUIREMENTS.MD` and `DB_DESIGN.MD` are authoritative.** They specify the system
down to individual `CHECK` constraints, and the code cites them constantly —
`BR-09`, `FR-02.4.1`, `NFR-01`, `RD-03`. When a comment names a rule, that rule is
written out in one of those two files; read it before changing the code around it.
When behaviour and the spec disagree, the spec is right unless the user says
otherwise.

## The one idea to understand first

**The money and stock rules live in the database, not the service layer.**

Overpaying a sale, selling another shop's stock, giving a customer a staff status,
posting the same receipt twice, driving stock negative — each is refused by a
constraint, not an `if`. Services still check the ordinary cases so users get a
readable sentence, but the constraint is the guarantee.

Three consequences that shape everything:

- **`synchronize` is off, permanently** (NFR-17). ~15 rules are composite foreign
  keys, `DEFERRABLE` clauses, partial indexes and generated columns TypeORM cannot
  model. A schema sync drops what it does not know about — it would silently delete
  the enforcement. All DDL is hand-written in `src/database/migrations/`.
- **Tests run against a real PostgreSQL.** Mocking a repository verifies nothing
  about a rule that lives in the database.
- **Never edit an applied migration.** Add a new one. Migrations are numbered and
  dependency-ordered; `src/database/migrations/1756000000001-ReferenceLists.ts`
  explains why reference lists must exist before everything else.

## Commands

```bash
npm run start:dev            # watch mode
npm run build                # nest build
npm run lint                 # eslint --fix
npm run format               # prettier

npm run migration:run        # apply migrations
npm run migration:revert     # roll back the last one
npm run db:reset             # drop schema + re-apply everything
npm run seed:admin           # first Owner account (the API cannot create it)

npm run test:db              # both suites (237 tests)
npm run test:schema          # 58 constraint/trigger/message tests (Jest)
npm run test:e2e             # 179 API tests (node:test via ts-node)
```

Both suites need `DATABASE_URL_TEST` and will truncate that database.

### Running a single test

```bash
# one Jest test by name
npx jest --config ./test/jest-schema.json -t "BR-50 refuses a sale line"

# one e2e file (they are executed directly, not through a runner)
NODE_ENV=test npx ts-node -T test/e2e/sales.test.ts
```

### Database setup

```bash
createdb fashion_express && createdb fashion_express_test
cp .env.example .env         # then set BETTER_AUTH_SECRET (openssl rand -base64 32)
npm run migration:run
```

`./scripts/dev-postgres.sh start` runs a throwaway cluster under `.devdb` on port
55432 if you would rather not touch the system PostgreSQL.

## Why there are two test runners

Not a preference — three constraints collide:

1. **better-auth is ESM-only** (no CJS build), and Jest decides a module's type from
   its extension before any transform runs. A `.mjs` dependency cannot load in its
   CommonJS registry at all.
2. **NestJS needs `emitDecoratorMetadata`** — for DI *and* for `ValidationPipe` to
   know which DTO class a `@Body()` refers to. esbuild (so `tsx`) cannot emit it,
   and without it request validation silently stops working. ts-node emits it.
3. **`node --test` loads `.ts` through the ESM loader**, defeating ts-node's
   CommonJS hook — but `node:test` runs fine when a file is simply *executed*.

So `scripts/test-e2e.sh` runs each `test/e2e/*.test.ts` directly under ts-node, one
at a time (they share a database and `loadFixture()` clears it). The SQL suites in
`test/schema/`, which import no better-auth, stay on Jest.

## Architecture

```
src/
  common/      money decimals, pg-error filter, transactions + lock ordering,
               RD-01 identifier generators, pagination, query-result helpers
  config/      zod-validated env, TypeORM DataSource, better-auth
  database/    migrations — the schema, hand-written
  modules/     one per FR group (sales/ is split four ways)
test/
  schema/      constraint and trigger suites (Jest)
  e2e/         API suites (node:test)
api/           per-entity docs + a Postman collection
```

### Authorisation

- **`AuthGuard` is global** (`APP_GUARD`), so every route requires a session by
  default; `@Public()` is the only way out.
- **Capability comes from the user *type***, not the account —
  `permissions` + `user_type_permissions`. `@RequirePermission('finalize_sale')`,
  `@RequireManager()`, `@RequireSuperuser()`. `PermissionsService` caches grants per
  type and **`invalidate()` must be called when grants change** (BR-56 requires the
  change to take effect immediately).
- **BR-01 is deliberately not a guard.** "A non-manager sees only the sales they
  created" is row filtering: `SalesService.visibility()` returns a WHERE fragment
  that every read path includes — list, detail, line items, payments, and the
  document/export routes. A sale outside scope returns **404, not 403**. Adding a
  new read path over sales means wiring that scope in.

### Identity

better-auth is mounted by hand in `main.ts` (`toNodeHandler`), **before the body
parsers** — it reads the raw body itself. It maps onto the business `users` table
rather than owning its own, so every `created_by_id` in the schema keeps pointing at
one place. `users.password_hash` does not exist; the hash lives in
`accounts.password`.

## Conventions and traps

These have each cost real debugging time.

- **`query()` returns two shapes.** TypeORM gives `rows` for a SELECT but
  `[rows, affectedCount]` for INSERT/UPDATE/DELETE. Read naively, an
  `INSERT … RETURNING id` yields `undefined` and a `.length === 0` check never fires,
  so a missing row becomes a silent success. Always go through `rowsOf` / `firstRow`
  / `affectedRows` in `common/sql.ts`.
- **Never `@Type(() => Boolean)` on a query parameter.** `Boolean("false")` is
  `true`, so the filter silently means the opposite of what was asked. Use
  `@ToBoolean()` from `common/to-boolean.ts`, which rejects anything it cannot parse.
- **Money and quantities are decimal strings end to end** (NFR-01). `pg` returns
  `numeric` as a string; keep it that way and use `decimal.js`. No `parseFloat`
  anywhere near money. Convert to a number only at an export boundary, where a
  spreadsheet format demands it.
- **IDs are strings too** — 64-bit integers that would lose precision as JSON numbers.
- **Code pairs are written by one helper.** Where a row carries both `*_id` and
  `*_code` (`sales.status_*`, `sale_items.item_type_*`,
  `supplier_purchase_payments.method_*`, `bill_claims.status_*`), a composite FK pins
  them together. Never set them independently — see `modules/sales/status.ts`.
- **Statement order matters for `sale_not_overpaid`.** It is a plain `CHECK`
  maintained by an `AFTER` trigger, so it fires on the statement that shrinks a sale.
  Payments must be deleted *before* the lines that justify them (FR-02.6.2).
- **Lock order is fixed** (DB_DESIGN.MD §16): customer/supplier first, then children.
  `common/transaction.ts` warns in development when a transaction takes them out of
  order — two paths locking in opposite orders is the classic deadlock.
- **`TRUNCATE users CASCADE` empties the reference lists.** Every reference table
  carries `created_by_id -> users`, so the cascade reaches statuses, units and the
  rest. Use `DELETE` (the FKs are `ON DELETE SET NULL`), users before shops.
- **Reference data is registry-driven.** All twelve lookup lists are served by one
  controller; `modules/reference/registry.ts` describes each and is also the SQL
  whitelist. Three lists are *structural* — label editing only, no create, no delete,
  no deactivate (BR-61, BR-66).
- **Constraint violations surface by name.** The global filter maps SQLSTATE +
  constraint name to a message in `common/constraint-messages.ts`. Match on the
  **constraint name, never the table** — `sale_not_overpaid` reports against `sales`,
  not `sale_payments`, because the trigger propagates the payment into the sale.
- **A foreign key fails in two opposite directions and needs two messages.** The
  same constraint refuses *"you referenced a shop that does not exist"* (422) and
  *"this shop is still in use, deactivate it"* (409). A name in
  `CONSTRAINT_MESSAGES` wins outright; everything else is built from PostgreSQL's
  `DETAIL` line plus `ENTITY_LABELS`, so a new table needs a row there and not a
  hundred constraint entries. Never echo `DETAIL` itself — on a NOT NULL violation
  it is the whole failing row.

## Documentation

`api/` holds one file per entity with curl examples that were run against a live
server, plus a Postman collection. `api/PLANNED.md` records what is deliberately out
of scope. Keep these in step when routes change.
