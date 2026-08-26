# Fashion Express — Requirements

**Status:** Baseline (behaviour of the system as built) **+ FR-11, FR-12 — specified, not yet implemented**
**Scope:** Single organisation operating one or more shops, web-based
**Backend:** NestJS (TypeScript) on PostgreSQL
**Currency:** Bangladeshi Taka (৳) — single currency, no FX
**Time zone:** Asia/Dhaka
**Companion document:** [DB_DESIGN.MD](DB_DESIGN.MD) — the data model that satisfies these requirements

> **Change notes.**
> **FR-11 Shops (2026-08-25)** — introduces shops and scopes customers, inventory, and sales to
> them (BR-47 … BR-55). Two items need a business decision first, marked **OPEN** in §10.
> **FR-12 Reference data (2026-08-25)** — replaces free-text and hard-coded lists with managed
> lookup tables: user types, job positions, departments, statuses (staff, customer, and sale),
> product categories, expense categories, units, stock transaction types, sale item types, and
> payment methods for customers, suppliers, and expenses (BR-56 … BR-64). Closes deviation D-05.
> **FR-12.11, FR-12.12 (2026-08-26)** — the last two fixed lists are converted as well: claim
> states join the statuses list under a `claim` scope, and ledger entry types and sources become
> managed lists of their own (BR-65, BR-66). FR-12.6 previously held these back and is rewritten:
> **no enumerated list stays hard-coded**. What keeps that safe is unchanged — codes are immutable
> (BR-59), a code a rule reads is carried on the row itself (BR-63, BR-64, BR-65), and where a new
> value would mean a behaviour nobody has written, the database refuses the record (FR-12.8.4,
> FR-12.11.2).
> **Platform (2026-08-25)** — the backend is being rebuilt on **NestJS**. This document describes
> required *behaviour*, which is unchanged by that; but the permission model in §3.2 was inherited
> from Django and does not survive the move. It needs redesigning — see §10.3.
>
> Everything outside FR-11 and FR-12 describes behaviour the current system already has. Those two
> describe work not yet built.

---

## 1. Purpose

Fashion Express manages the full commercial cycle for a single trading business:
selling goods and machines to customers, tracking the stock those sales draw down,
buying from suppliers, recording operating expenses and staff reimbursements, and
reconciling every money movement into one running balance.

This document states **what the system must do** and **which rules must never be
violated**. It is written to be traceable: every requirement carries an ID, and
[DB_DESIGN.MD](DB_DESIGN.MD) maps each business rule to the database constraint that
enforces it.

### Requirement ID scheme

| Prefix | Meaning |
|--------|---------|
| `FR-nn.n` | Functional requirement — something a user can do |
| `BR-nn` | Business rule — an invariant the system must never break |
| `NFR-nn` | Non-functional requirement — quality, security, performance |
| `RD-nn` | Reference data — a fixed value list or identifier format |

---

## 2. Glossary

| Term | Meaning |
|------|---------|
| **Shop** | One trading location of the business. Customers, stock, and sales each belong to exactly one shop. Shops keep separate books; they are not separate businesses. |
| **Reference list** | A short, business-managed vocabulary stored in its own table — job positions, departments, product categories, units, statuses, user types. Editable by staff without a code change. |
| **User type** | A staff member's single classification (Owner, Manager, Finance, Employee). Determines their privilege level. Distinct from permission groups, which grant individual rights. |
| **Code vs label** | Every reference list row has a stable machine `code` that code may rely on, and a `label` that staff may freely rename. |
| **Sale** | One commercial document. Passes through quotation → draft → finalised. Also called an order or invoice depending on state. |
| **Line item** | One row on a sale. Either a **stocked product** drawn from inventory, or a **machine** — a free-text, one-off item never held in stock. |
| **Finalise** | The irreversible act of committing a sale: stock is validated and deducted, and the sale begins counting toward revenue and dues. |
| **Sale payment** | Money received against one specific sale. Always carries a receipt number. |
| **Customer payment** | A single lump sum from a customer, automatically spread across their outstanding sales. Produces one sale payment per sale it touches. |
| **Purchase** | One buying transaction from a supplier. Paid down over time. |
| **Bill claim** | A staff member's request for reimbursement of money they spent on the company's behalf. |
| **Ledger** | The single append-only record of every credit and debit in the system. |
| **Low stock** | An inventory item whose quantity has fallen to or below its own minimum stock level. |

---

## 3. Actors and roles

### 3.1 Actors

| Actor | Description |
|-------|-------------|
| **Superuser** | Full system access including administration and destructive operations. |
| **Owner** | Business owner. Role group; in practice mapped to superuser. |
| **Manager** | Sees all sales, reviews bill claims, edits expenses, opens reports and the ledger. |
| **Finance** | Role group intended for payment and ledger work. |
| **Employee** | General staff. Creates sales, submits bill claims, sees only their own work. |

### 3.2 Permission model

**FR-00.1** — Every page requires authentication. There is no anonymous access.

**FR-00.2** — Access is granted through three mechanisms that combine:

1. **Record permissions** — standard create/read/update/delete rights per entity
   (e.g. "may add a sale", "may delete an inventory item").
2. **Menu and action permissions** — rights that gate navigation entries and specific
   actions with no record of their own: view the customers / inventory / expenses /
   reports / sales menus, submit a bill, view my bills, review bills, finalise a sale.
3. **User type** — each account's single classification (FR-12.1), which determines whether it
   holds unrestricted or manager privilege.

> Mechanisms 1 and 2 are described as the **current system** implements them, on Django's
> permission framework. That framework does not exist on NestJS, and mechanism 3 is the only one
> this rebuild currently has a design for. **The capabilities above are the requirement; the
> mechanism is not.** See §10.3.

**FR-00.3** — The navigation sidebar hides any module the signed-in user cannot open,
and individual action buttons are absent when the matching permission is missing.
Permission checks are enforced on the server for every route, not only in the UI.

**FR-00.4** — Four role groups ship with the system: Owner, Manager, Finance, Employee.
Roles are containers for permissions so capabilities can be granted or revoked per role
without editing individual accounts.

**FR-00.4.1** — **User types and permission groups are different things and both remain.** A user
type is a single classification that sets privilege level (FR-12.1); a permission group is a
bundle of individual rights, and an account may hold several. Types answer *what is this person*;
groups answer *what may they do*. Granting a permission stays a group operation — user type must
not become a second, competing permission system.

### 3.3 Sale visibility

**BR-01** — A user who is not a manager or superuser may see **only the sales they
created**. This applies uniformly to the sales list, every sale detail page, all sale
documents, and all exports. There is no route by which a non-manager can read another
user's sale.

**FR-00.5** — Managers get a "created by" filter on the sales list to review the work of
one salesperson. Attempting to use that filter as a non-manager must not widen visibility.

### 3.4 Staff accounts

**FR-00.6** — A staff account carries login credentials plus employment details: **job
position**, **department**, phone, address, salary, join date, and notes. Job position and
department are chosen from managed lists (FR-12.2), not typed as free text.

**FR-00.7** — Each account has a status of **Active**, **Inactive**, or **On Leave**, chosen from
the staff status list (FR-12.3). Only accounts whose status is `active` count toward the "active
employees" figure.

**FR-00.7.1** — Each account has exactly one **user type** (FR-12.1), which determines its
privilege level. Account status and user type are independent: suspending an Owner does not stop
them being an Owner.

**FR-00.8** — An employee ID is generated automatically when an account is created and is
never editable.

### 3.5 Login protection

**FR-00.9** — After **5 consecutive failed sign-in attempts** for a given
username + IP address combination, further attempts from that combination are refused.

**FR-00.10** — The lockout expires after **1 hour**; a successful sign-in resets the counter.

---

## 4. Module requirements

> Requirement IDs are assigned in the order features were specified, not in document order.
> FR-11 appears first below because every other module now depends on it; its number is higher
> because it was added last. Existing IDs never change, so references from code, tickets, and
> [DB_DESIGN.MD](DB_DESIGN.MD) stay valid.

---

### FR-11 — Shops · *not yet implemented*

The business operates more than one shop. Customers, stock, and sales are each recorded against
the shop they belong to, so each shop's trading can be seen on its own.

#### FR-11.1 — The shop record

**FR-11.1.1** — A shop holds a **name** and a **description**. Both are free text; the
description may be empty.

**FR-11.1.2** — A shop carries an **active / inactive** status. Inactive shops keep all their
history but are not offered when creating new records.

**BR-47** — A shop's name is **unique, ignoring case**. "Gulshan Branch" and "gulshan branch"
are the same shop and the second must be refused.

#### FR-11.2 — Managing shops

**FR-11.2.1** — Shops can be created, viewed, edited, and deleted by staff holding the matching
permissions. The list is searchable by name.

**FR-11.2.2** — The shop list shows, per shop, the number of customers, stocked products, and
sales attached to it, so the consequences of deactivating one are visible before acting.

**BR-48** — A shop that has **any** customer, inventory item, or sale attached **cannot be
deleted**. Deletion is available only for a shop that was created in error and never used.

**FR-11.2.3** — Because BR-48 makes deletion rare, **deactivating** is the normal way to retire a
shop. An inactive shop disappears from selection lists but its historical data stays intact and
continues to appear in reports.

#### FR-11.3 — What is scoped to a shop

**BR-49** — Every **customer**, **inventory item**, and **sale** belongs to exactly one shop. The
shop is required; there is no "unassigned" state.

**BR-50** — A sale's line items may only draw on **inventory belonging to the same shop as the
sale**. One shop can never sell another shop's stock, whether through the sale form, an import,
or a direct database write.

**BR-51** — A product code is **unique within a shop**, not across the business. Two shops may
each stock a product coded `CLP-001`, and those are two independent records with their own
quantity, pricing, and movement history.

**BR-52** — Low stock (BR-24) is evaluated **per shop**: an item is low when its own quantity
falls to or below its own minimum, regardless of stock held elsewhere.

**BR-53** — A sale's **customer must belong to the same shop as the sale**. *(OPEN — see §10.1;
this is the recommended default but is a business policy choice, not a technical one.)*

**BR-54** — A record's shop is **fixed at creation**. Moving stock between shops is a transfer,
which is out of scope (§7); reassigning a customer or a past sale to a different shop is not
supported.

#### FR-11.4 — What is *not* scoped to a shop

Stated explicitly so the boundary is not guessed at:

| Not scoped | Why |
|-----------|-----|
| **Suppliers and purchases** | Buying is done centrally for the business, not per shop. |
| **Expenses** | Not requested. See §10.2 — this is what prevents per-shop profit. |
| **Bill claims** | Attached to the staff member who submitted them. |
| **Ledger** | One running balance for the whole business. |
| **Stock movements** | Each movement belongs to one inventory item, which already belongs to one shop. The shop is derived, never stored twice. |
| **Sale payments** | Each belongs to one sale, which already carries the shop. |

#### FR-11.5 — Seeing one shop at a time

**FR-11.5.1** — The customer list, inventory list, and sales list each gain a **shop filter**.
Every summary total on those screens respects it, exactly as the existing filters do (FR-02.8,
FR-04.4).

**FR-11.5.2** — The dashboard gains a shop selector. Selecting a shop restricts every figure on
it — counts, stock value, sale totals, top products, low-stock alerts — to that shop. The default
view aggregates all shops.

**FR-11.5.3** — Reports (FR-09) gain a per-shop breakdown, and shop is a column in the sales and
customer exports.

**FR-11.5.4** — When creating a customer, an inventory item, or a sale, the shop is chosen on the
form and defaults sensibly. *(OPEN — see §10.1.)*

---

### FR-12 — Reference data · *not yet implemented*

Twelve vocabularies the business should own and maintain, instead of them being free text typed
into every record or a fixed list buried in the source code.

| List | Replaces | Applies to |
|------|----------|-----------|
| **User types** | `is_superuser`, `is_staff`, `is_manager` booleans | Staff accounts |
| **Job positions** | free-text `position` | Staff accounts |
| **Departments** | free-text `department` | Staff accounts |
| **Statuses** | hard-coded `status` values | Staff accounts, customers, sales, bill claims |
| **Categories** | free-text `category` | Inventory |
| **Expense categories** | hard-coded `category` values | Expenses |
| **Units** | hard-coded `unit` values | Inventory |
| **Transaction types** | hard-coded `transaction_type` values | Stock movements |
| **Item types** | hard-coded `item_type` values | Sale line items |
| **Payment methods** | hard-coded `method` values and free-text `payment_method` | Sale payments, customer payment batches, supplier payments, expenses |
| **Ledger entry types** | hard-coded `entry_type` values | Ledger |
| **Ledger sources** | hard-coded `source` values | Ledger |

Plus one more that is not a new list at all: an inventory item's **supplier** stops being typed
text and becomes a reference to the supplier record that already exists (FR-04.1.1).

#### FR-12.1 — User types

**FR-12.1.1** — A user type has a stable **code**, an editable **label**, and a description.
Four ship with the system: Owner, Manager, Finance, Employee.

**FR-12.1.2** — A user type declares the privilege it confers: whether holders have
**unrestricted access**, and whether they count as **managers**.

**BR-56** — A user's type is the **only** place their privilege is recorded. No privilege flag is
stored on the account itself. Changing a person's type changes their privileges; changing what a
*type* confers changes them for everyone holding it, immediately.

**BR-57** — Every account has **exactly one** user type. There is no untyped account.

> **Why there is no third flag.** The current system carries `is_superuser`, `is_staff`, and
> `is_manager` on each account. `is_superuser` and `is_staff` are Django's own fields, required
> by its permission backend and admin site — which is why an earlier draft of this requirement
> kept them as values derived from the type. On NestJS neither exists, so all three are removed
> and the type is read directly. `is_staff` has no successor: it only ever meant "may open the
> Django admin site". Where the old code used it as a loose stand-in for "administrator", that
> becomes an unrestricted-access check or a named permission. See DB_DESIGN.MD §23.3.

#### FR-12.2 — Job positions and departments

**FR-12.2.1** — Both are simple named lists with an active/inactive flag, managed through the
same screens as every other reference list.

**FR-12.2.2** — Both are **optional** on a staff account. Existing accounts that have neither
stay valid.

#### FR-12.3 — Statuses

**FR-12.3.1** — Statuses live in one list, but each entry belongs to a **scope** naming what it
describes. There are four: staff accounts, customers, sales (FR-12.8.1), and bill claims
(FR-12.11.1).

**BR-58** — A status may only be used by the entity type it is scoped to. A customer can never
be set to **On Leave**, a staff account can never take a customer-only status, and a bill claim
can never take either — regardless of how the record is written.

**FR-12.3.2** — Seeded content: staff — Active, Inactive, On Leave; customers — Active, Inactive;
sales — RD-03; bill claims — RD-08. This preserves today's behaviour exactly.

#### FR-12.4 — Categories, units, and supplier

**FR-12.4.1** — **Categories** are a flat named list, shared across all shops. A category is not
per-shop: two shops selling fasteners are selling the same kind of thing.

**FR-12.4.2** — **Units** have a stable code and an editable label, seeded with Pieces, Box,
Kilogram, Litre, Metre — but now extensible without a code change.

**FR-12.4.3** — An inventory item's **supplier** is a reference to a supplier record (FR-04.1.1).

#### FR-12.5 — Managing the lists

**FR-12.5.1** — Each list supports create, view, edit, and deactivate, restricted to staff
holding the matching permission. These are administrative screens, not day-to-day ones.

**FR-12.5.2** — The **structural** lists are the exception: stock transaction types (BR-61),
ledger entry types, and ledger sources (BR-66) offer editing of the label only. Their screens
present no "add" action and no delete, because the system is the only writer of the records that
use them.

**BR-59** — A reference entry's **code is fixed once created**; only its **label** may be edited.
Renaming *Pieces* to *Units* is safe. Changing the code `pcs` is not, because application logic
and historical records are keyed on it.

**BR-60** — A reference entry **referenced by any record cannot be deleted**. Deactivating it is
the supported action: it disappears from selection lists while every existing record keeps its
meaning.

#### FR-12.7 — Stock transaction types

**FR-12.7.1** — The three stock movement types (RD-07) move into a managed list: **Stock In**,
**Stock Out**, **Adjustment**.

**FR-12.7.2** — Each type carries a **direction** stating whether it increases stock, decreases
it, or may do either. The movement history uses that direction to decide how a row is presented —
the `+` or `−` sign and its colour — instead of comparing the type's code to string literals.

**BR-61** — Transaction types are **structural**. Staff may rename a type's label, but may not
add or remove types. Stock movements are written only by the system (BR-25), so a type nobody
can write is an entry that would sit in the list for ever without appearing on a single record.

> **This reverses the position FR-12.6 originally took, deliberately and at the business's
> request.**
> Movement types met the test for staying fixed: application logic branches on them. The reason
> it is nonetheless workable here is BR-61 — the list is editable in its *labels* only, and the
> codes stay immutable under BR-59, so the branching keeps working. Adding a genuinely new
> movement type remains a development task: it needs code that writes it and code that presents
> it, neither of which appears by creating a row.
>
> The direction column is what makes the change worth making rather than merely tidy: it moves a
> piece of presentation logic out of a template and into data, where it can be read once and
> applied consistently.

#### FR-12.8 — Sale statuses and item types

**FR-12.8.1** — The four sale states (RD-03) join the statuses list under a **sale** scope,
alongside the existing staff and customer scopes.

**FR-12.8.2** — The two sale line kinds (Inventory, Machine) become a managed **item types** list.

**BR-63** — Both are recorded on the row **together with the code they refer to**, and the two
can never disagree. This is what allows the rules that depend on them to keep working — see the
warning below.

> **These two carry more risk than the earlier lists, and it is worth being explicit about why.**
> Four things in the system read these values directly rather than as labels:
>
> - a finalised sale must have a finalisation time, and nothing else may (BR-07);
> - a machine line must not point at stock, and a stocked line must (BR-04);
> - the index that drives customer payment allocation is built only over finalised sales (BR-16);
> - totals exclude drafts and quotations (BR-03).
>
> All four keep working. None of them could if the row held only an id — a rule that checks one
> record cannot look inside another table. The design solves it by keeping the code on the row
> as well as the reference. **The practical consequence: renaming a label is safe, but the codes
> `quote`, `draft`, `finalized`, `cancelled`, `inventory`, and `non_inventory` are load-bearing
> and fixed (BR-59).**

**FR-12.8.3** — Adding a **new sale status** is permitted but changes nothing on its own: reports,
totals, and the sale workflow all enumerate the states they understand, and a new one will simply
never be reached.

**FR-12.8.4** — Adding a **new item type** is refused at the point of use: a line item referring
to an unknown kind is rejected outright. An item type is not a label but a choice between two
differently shaped records — one drawing on stock, one free text — so a third kind needs to be
built, not listed.

#### FR-12.9 — Payment methods

**FR-12.9.1** — The five customer payment methods (RD-04) become a managed list, used by both
sale payments and customer payment batches. The two must always agree: a batch and the payments
it generates record the same method (BR-19).

**BR-62** — Payment methods are **scoped**, and there are three scopes: **customer**,
**supplier**, and **expense**. A customer payment may only use a customer method, a supplier
payment a supplier method, and an expense an expense method. LC, TT, and bank exist for suppliers
and must never appear on a customer receipt.

**FR-12.9.2** — **Supplier payment methods (RD-06) are converted too**, under the `supplier`
scope. This reverses the earlier decision to leave them as a fixed list.

**BR-64** — A supplier payment records its method **together with the method's code**, and the two
can never disagree. This is the same device FR-12.8 uses for sale statuses and item types, and it
is here for the same reason: BR-29 has to read the method from the payment row itself.

> **BR-29 is what made this need care rather than a rename.** The rule that LC, cheque, TT, and
> bank payments must carry a reference number, and cash need not, is a check on a single payment
> row — it cannot look the method up in another table. Keeping the code on the row is what lets it
> go on working untouched. The practical consequence matches FR-12.8's: the codes `lc`, `check`,
> `tt`, `cash`, and `bank` are load-bearing and fixed (BR-59); the labels are free.
>
> **Adding a new supplier method is permitted, and it fails safe.** A payment using an unfamiliar
> code is accepted, and BR-29 then requires a reference number for it, because the rule exempts
> `cash` alone. A new instrument therefore errs toward demanding a trace, which is the right
> default for a method nobody has written code for yet. Contrast FR-12.8.4, where a new item type
> is refused outright — an item type describes a differently *shaped* record, a payment method
> only a differently *named* one.

#### FR-12.10 — Expense categories and expense payment methods

**FR-12.10.1** — The eight expense categories (RD-05) become a managed list. Nothing in the
application branches on which category an expense carries — it is pure classification — so the
business can own it outright, and a ninth category needs no deployment.

**FR-12.10.2** — Each entry keeps a stable code alongside its label, even though no logic reads
it, because every expense already on file records one and saved report filters are written in
terms of them. Renaming *Supplies* to *Consumables* must not silently re-file years of history.

**FR-12.10.3** — An expense's **payment method** stops being free text and becomes a reference to
the payment methods list (FR-12.9) under the `expense` scope. It stays **optional**: an expense
may be recorded without stating how it was settled, exactly as today.

**FR-12.10.4** — The expense list's category filter (FR-06.4) and the expenses-by-category report
(FR-09.1) both read the list rather than a fixed set, so a new category appears in both with no
code change.

**FR-12.10.5** — Because the column being replaced was never validated, the migration harvests
whatever distinct values it already holds into the list, the same way job positions and
departments are harvested (FR-12.2). Someone has to look at the result and merge the
near-duplicates before it becomes permanent.

#### FR-12.11 — Claim statuses

**FR-12.11.1** — The three claim states (RD-08) join the statuses list under a **claim** scope,
alongside staff, customer, and sale. A bill claim's status stops being a hard-coded value and
becomes a reference, exactly as a sale's did.

**BR-65** — A bill claim records its status **together with the code it refers to**, and the two
can never disagree. This is the same device FR-12.8 uses for sale statuses and FR-12.9.2 for
supplier payment methods, and it is here for the same reason: the rules governing approval read
the status from the claim row itself.

> **What reads a claim's status directly.** The three obligations that make a claim well-formed —
> a pending claim has no reviewer, no review date, and no expense; an approved one must have a
> review date and the expense it created (BR-36); a rejected one has a review date and no expense
> (BR-37) — are a single-row rule, and a single-row rule cannot look inside another table. Keeping
> the code on the row is what lets it keep working. The practical consequence matches FR-12.8's:
> the codes `pending`, `approved`, and `rejected` are load-bearing and fixed (BR-59); the labels
> are free.

**FR-12.11.2** — Adding a **new claim status** is refused at the point of use: a claim carrying a
status outside those three is rejected outright, the same way an unknown item type is
(FR-12.8.4). A claim state is not a label but a position in an approval workflow with obligations
attached — a fourth state needs those obligations defined before it can be recorded, not merely
listed.

**FR-12.11.3** — The claim lists and their status filters (FR-07.3, FR-07.4) read the list rather
than a fixed set, and display the label.

#### FR-12.12 — Ledger entry types and sources

**FR-12.12.1** — The two ledger entry types (RD-11) become a managed list: **Credit** and
**Debit**.

**FR-12.12.2** — Each entry type carries a **direction** — `+1` for a credit, `−1` for a debit —
and the running balance is computed from that direction rather than by comparing a stored value
to the literal `credit`. This is the same treatment stock movement types receive under FR-12.7.2,
and it is the reason converting this list is worth doing rather than merely tidy: it moves the
one piece of arithmetic that defines the balance out of code and into data that can be read once
and applied everywhere.

**FR-12.12.3** — The four ledger sources (RD-11) become a managed list of their own: **Sale
payment**, **Expense**, **Supplier payment**, **Other**.

**BR-66** — Ledger entry types and sources are **structural**. Staff may rename a label, but may
not add or remove entries. This is the same rule BR-61 applies to stock movement types, and it
holds for the same reason: the ledger is written only by the system (BR-38), so a source nobody
can write is an entry that would sit in the list for ever without appearing on a single record,
and a third entry type would need a meaning in the balance that no direction can supply.

**FR-12.12.4** — Neither list is carried as a copied code on the ledger row. Nothing reads either
value from the entry itself — the balance reads `direction` from the entry type, and the
duplicate-protection rule (BR-39) keys on the source *reference*, not on its name — so there is
nothing to keep in step. Contrast BR-63, BR-64, and BR-65, where a rule examining one row forces
the copy.

#### FR-12.6 — Where the safety now comes from

Earlier drafts of this document kept a short list of enumerations that stayed hard-coded, on the
principle that **a value code branches on must not be user-editable**. FR-12.7 through FR-12.12
emptied that list one entry at a time, and the last two — claim states and ledger types and
sources — went with FR-12.11 and FR-12.12. **No enumerated list is hard-coded any more.**

The principle was not wrong; it was aimed at the wrong thing. What actually matters is not
whether a list *lives in a table* but whether the rules that read it can still read it, and
whether a value the business invents can reach code that does not know about it. Four safeguards
carry that, and every list converted above rests on at least one:

| Safeguard | What it prevents |
|-----------|------------------|
| **Codes are immutable** (BR-59) | Renaming *Pieces* to *Units* is safe; changing `pcs` is not possible. |
| **The code is carried on the row** (BR-63, BR-64, BR-65) | A rule examining a single record can still read the value it depends on. |
| **Structural lists refuse new entries** (BR-61, BR-66) | Stock movement types, ledger entry types, and ledger sources are written only by the system; a row nobody writes cannot appear. |
| **A new value is refused at the point of use** (FR-12.8.4, FR-12.11.2) | An item type or claim status outside the set the code handles is rejected by the database, not accepted and left unprocessable. |

Two of those needed inventing before the last conversions were safe, which is the honest reason
this section shrank rather than being deleted in one step. What must never happen is a list whose
**values** the business can invent while code elsewhere assumes it knows them all; the table above
is the record of how each list is held to that.

---

### FR-01 — Dashboard

The landing page after sign-in, assembled live from current records.

**FR-01.1** — Show headline counts: active employees, active customers, inventory items
held, items low on stock, and total value of stock on hand.

**FR-01.2** — Show sale figures: sales still in draft, sales finalised, today's finalised
sales total, and total outstanding across all finalised sales (invoiced less received).

**FR-01.3** — Show this month's total expenses and the count of bill claims awaiting review.

**FR-01.4** — Show the **top 10 products by quantity sold** across all finalised sales,
covering both stocked products and machine lines. Machine lines are grouped by the first
meaningful line of their description so that repeat sales of the same machine aggregate.

**FR-01.5** — Show the first five low-stock items, the five most recent sales, and the
five most recent expenses.

**FR-01.6** — A low-stock count must be visible on **every page** of the application, not
only the dashboard.

**FR-01.7** — Users whose only permissions are bill-related see a reduced dashboard
offering just "Submit a Bill" and "My Bills".

**FR-01.8** — Every figure on this page is filterable by shop (FR-11.5.2). Expenses and bill
claims are the exception: they are not shop-scoped (FR-11.4), so those two tiles show
business-wide figures whatever shop is selected, and are labelled to say so.

---

### FR-02 — Sales and quotations

The largest module: quotations, invoices, stock draw-down, payments, and printable documents.

#### FR-02.1 — Sale states

| State | Meaning | Affects stock | Counts in totals |
|-------|---------|---------------|------------------|
| **Quotation** | A priced offer to a customer | No | No |
| **Draft** | An order being assembled | No | No |
| **Finalised** | Confirmed sale; stock has been issued | Yes — deducted | Yes |
| **Cancelled** | Abandoned | No | No |

**BR-02** — Stock is untouched in every state except the transition into **Finalised**.
Quotations and drafts may be edited freely without disturbing the warehouse.

**BR-03** — Draft and quotation sales are **excluded from all revenue and dues totals**
wherever those totals are shown (sales list, dashboard, customer account, exports).

#### FR-02.2 — Creating a sale

- One form captures the customer, any number of line items, and an optional first payment
  together in a single submission.
- A customer not yet on file can be added inline from the same form without losing entered work.
- Each line item is either a **stocked product** selected from inventory or a **machine**
  described in free text.
- Each line takes a quantity, an optional box count, and a unit price. Line totals and the
  order total are calculated by the system, never entered by hand.
- If a stocked line is saved with a unit price of zero or blank, the product's current
  selling price is applied automatically. A positive entered price always wins.
- A dedicated **quotation mode** produces the same document as an offer.

**BR-04** — A machine line **must** carry a description. A stocked line **must** reference
an inventory item. Neither may be saved without it.

**BR-05** — A sale must have at least one valid line item to be created.

**FR-02.2.1** — The sale is created against a shop (FR-11.5.4). Only that shop's stock is offered
in the line-item picker, and only that shop's customers in the customer picker — enforcing BR-50
and BR-53 at the point of entry rather than only on save.

#### FR-02.3 — Converting a quotation

**FR-02.3.1** — A quotation can be converted to an invoice in one step, preserving its
items and prices. It becomes a draft and follows the normal invoice flow from there.

#### FR-02.4 — Finalising

**BR-06** — Stock availability is validated for **every** line before **any** deduction
occurs. Both loose units and whole boxes are checked. If any line is short, the entire
finalisation is refused and nothing is changed.

**BR-07** — Finalisation is atomic: the stock deductions, the stock-movement records, and
the status change either all succeed or all roll back.

**FR-02.4.1** — On success, quantities and box counts are deducted and a stock movement is
recorded against each affected product, naming the sale and the user who finalised it.

**FR-02.4.2** — If a deduction takes an item to or below its minimum level, the user is
told immediately which items now need reordering.

**FR-02.4.3** — Finalising requires its own distinct permission, so the staff who assemble
orders need not be the staff who commit them.

**BR-08** — A sale that is already finalised cannot be finalised again.

#### FR-02.5 — Payments against a sale

- Any number of part-payments may be recorded. Amount paid and balance due are always current.
- Every payment is issued a unique receipt number and has its own printable receipt.
- Payments may be edited or deleted by staff holding those permissions.

**BR-09** — The total of all payments against a sale must never exceed the sale's total
value. This holds when adding a payment and when editing an existing one.

**BR-10** — No payment may be recorded for an amount of zero or less.

**BR-11** — Payments cannot be recorded against a cancelled sale, nor against a quotation.

#### FR-02.6 — Editing a finalised sale

**FR-02.6.1** — Adding or removing a line on an already-finalised sale is restricted to
administrators.

**BR-12** — When a line is removed from a finalised sale, the stock that line consumed is
**returned to inventory** and a reversing stock movement is recorded. Stock is never
silently lost.

**BR-13** — When a line is added to a finalised sale, stock is validated and deducted
immediately, exactly as at finalisation.

**FR-02.6.2** — If removing lines empties a finalised sale, the sale reverts to draft, and
any payments recorded against it are deleted so no orphaned overpayment remains. The user
is told how many payments were removed.

#### FR-02.7 — Deletion

**BR-14** — Only **draft** sales may be deleted. Finalised, cancelled, and quotation sales
are not deletable through the application.

#### FR-02.8 — Finding and reviewing sales

- Search by sale number, customer name, or customer ID.
- Filter by **shop** (FR-11.5.1), state, created-date range, item kind (stocked products vs
  machines), and — for managers — the staff member who created the sale.
- Running totals of value, received, and outstanding sit above the list and respect every
  applied filter.

**BR-15** — When filtering by item kind, totals are **apportioned**: a mixed order
contributes only the value of its matching lines, and received amounts are pro-rated by
that line share.

#### FR-02.9 — Documents and exports

- Printable **invoice** per sale, and a printable **receipt** per payment, both carrying
  the configured business name, address, phone, email, and logo.
- Quotations print on a distinct template marked as a quotation, valid 30 days from issue,
  and explicitly stating that it is not an invoice.
- Payment history for one sale as **CSV** and as a formatted **PDF statement**.
- Order history across sales as **CSV** and as a landscape **PDF report** with totals.

---

### FR-03 — Customers

**FR-03.1** — A customer record holds name, company, email, phone, address, city, status
(active or inactive), free-text notes, and the **shop** it belongs to (BR-49).

**FR-03.2** — A customer ID is issued automatically on creation. It is never editable and
never reused (see RD-01).

**FR-03.3** — Search across name, customer ID, company, and phone. Filter by status and by
**shop** (FR-11.5.1).

**FR-03.4** — The customer account view shows all finalised orders for that customer with
total invoiced, total received, and total due across the whole relationship, plus a history
of payment events showing how many invoices each was spread across.

#### FR-03.5 — Customer-level payment (FIFO allocation)

A single lump sum can be taken from a customer and distributed by the system rather than
settling invoices one at a time.

**BR-16** — The amount is applied **oldest finalised sale first**, ordered by finalisation
time, until it is exhausted.

**BR-17** — A customer payment may **not exceed the customer's total outstanding balance**.
If it would, the whole event is rejected and nothing is written.

**BR-18** — Each sale the payment touches receives its own payment record and its own
receipt number, so per-invoice histories remain accurate and independently printable.

**BR-19** — The whole event is grouped under one reference, with a combined receipt listing
every invoice it settled and the amount applied to each.

**BR-20** — Allocation must be serialised per customer: two simultaneous payments for the
same customer must not both allocate against the same outstanding balance.

**FR-03.5.1** — The payment action is offered only when the customer actually owes something.

**FR-03.5.2** — Allocation needs no shop rule of its own. A customer belongs to one shop and
(under BR-53) so do all their sales, so a customer payment is naturally confined to one shop's
books.

#### FR-03.6 — Deletion

**FR-03.6.1** — Deleting a customer shows a confirmation screen that counts the orders and
payment records that will be destroyed with them, and refuses to proceed until the user
explicitly acknowledges the loss.

**BR-21** — Deleting a customer cascades to their sales, sale line items, sale payments,
payment batches, and allocations. No orphaned financial record may survive its customer.

---

### FR-04 — Inventory

**FR-04.1** — A product record holds product name, a **product code unique within its shop**
(BR-51), description, warehouse location, purchase cost, selling price, a minimum stock level,
the **shop** holding it (BR-49), and three references to managed lists (FR-12.4): its
**category**, its **unit of measure**, and the **supplier** it is bought from.

**FR-04.1.1** — The supplier reference points at the supplier record itself (FR-05.1), not at a
typed-in name, so stock and purchasing can finally be reported together. This closes deviation
D-05.

**FR-04.1.2** — Category and supplier are **optional**; a product may have neither. Unit is
**required** — a quantity without a unit is meaningless.

**FR-04.2** — Quantity is held to **three decimal places** so part units measure cleanly.
A **box count** is tracked separately as a whole number for goods handled in boxes, drums,
or batches.

**BR-22** — Purchase cost and selling price are stored separately and never conflated, so
margin remains visible.

**BR-23** — Quantity, box count, and minimum stock may never be negative.

**FR-04.3** — Search by product name, code, or category. Filter by **shop** (FR-11.5.1), by
category, or show only items running low.

**FR-04.4** — A summary bar reports, **for the current filter**: matching product count,
total quantity, total boxes, and total stock value.

**BR-24** — An item is **low stock** when its quantity is at or below its own minimum stock
level. This single definition drives every low-stock warning in the system, and is evaluated
per shop (BR-52).

#### FR-04.5 — Movement history

**BR-25** — Every stock movement is recorded automatically. Movement rows are never written
by hand and are never edited or deleted.

**FR-04.5.1** — Each movement records the before and after figures for both units and boxes,
the reason, and the user responsible.

| Event | Recorded as | Reason shown |
|-------|-------------|--------------|
| Product created with stock | Stock in | Initial stock |
| Quantity raised on edit | Stock in | Stock added via edit |
| Quantity lowered on edit | Adjustment | Stock adjusted via edit |
| Sale finalised | Stock out | The sale number |
| Boxes issued on a sale | Stock out | The sale number, marked as boxes |
| Line removed from a finalised sale | Adjustment | Reversal, naming the sale |

**BR-26** — Unit movements and box movements are recorded as **separate rows** so the two
stock dimensions can be audited independently.

**BR-27** — A product that has ever appeared on a sale must not be deletable in a way that
destroys the sale's record of what was sold.

---

### FR-05 — Suppliers and purchases

**FR-05.1** — A supplier record holds name, address, phone, and email.

**FR-05.2** — The supplier list shows total purchased and total still owed per supplier,
searchable by name or phone.

**FR-05.3** — A purchase records the product description, price, purchase date, and notes.

**BR-28** — A purchase's **amount due is derived** from price less the sum of its payments.
It is never entered by hand and can never drift out of step with the payment records.

**FR-05.4** — The supplier page totals purchased, paid, and outstanding across every purchase.

#### FR-05.5 — Paying suppliers

- Payments may be made in instalments against any purchase.
- Every payment is issued its own receipt number.
- Payments may be edited or deleted; the purchase's paid figure is recalculated each time.

**BR-29** — A **reference number is mandatory** for LC, cheque, TT, and bank payments.
Cash payments require none.

**BR-30** — A payment against a purchase may not exceed that purchase's remaining due.

**BR-31** — When paying at the supplier level, the amount is allocated **oldest purchase
first** by purchase date, and may not exceed the supplier's total outstanding balance.

**BR-32** — An initial payment entered at the same time as a new purchase may not exceed
the purchase price, and both are saved atomically or not at all.

---

### FR-06 — Expenses

**FR-06.1** — An expense records date, category, description, amount, payee, receipt
number, payment method, and notes. **Category** and **payment method** are chosen from managed
lists (FR-12.10), not typed as free text. Category is required; payment method is optional.

**FR-06.2** — Categories come from the expense categories list, seeded with the eight in RD-05
and extensible without a code change (FR-12.10.1).

**FR-06.3** — Search across description, payee, and receipt number.

**FR-06.4** — Filter by category, a whole month, a single date, or a date range. An explicit
date range takes precedence over a month filter.

**FR-06.5** — The filtered total and the current ledger balance are shown above the list.

**BR-33** — Anyone holding the add permission may create an expense, but **only managers may
edit or delete one**.

**FR-06.6** — Where an expense originated from an approved staff claim, its detail page shows
the original claim, who submitted it, and who approved it.

---

### FR-07 — Bill claims

Staff claim money spent on the company's behalf; a manager approves or rejects; approval
writes the expense automatically.

**FR-07.1** — A claim carries an amount, a description, and the date of the bill.

**FR-07.1.1** — A claim's status is a reference to the claim-scoped statuses list (FR-12.11.1),
seeded with the three states in RD-08. It is set by the approval workflow and is never typed or
chosen freely.

**FR-07.2** — A supporting document may be attached.

**BR-34** — Attachments are restricted to a fixed extension whitelist: PDF, JPG, JPEG, PNG,
GIF, BMP, WEBP, DOC, DOCX, XLS, XLSX, CSV, TXT. Any other extension is refused.

**FR-07.3** — Staff see their own claims in one place, filterable by status.

**FR-07.4** — Managers see every claim from every employee, searchable by staff name or
description and filterable by status, with totals for pending, approved, and rejected shown
together.

**BR-35** — A claim that has already been approved or rejected **cannot be processed again**.

#### FR-07.5 — Approval

**BR-36** — Approving a claim must, as one action: mark it approved, record who approved it
and when, create an **expense** dated to the bill date with the employee as payee, and link
the claim to that expense so either can be traced from the other.

**BR-37** — Rejecting a claim records the reviewer and the date and creates **no** expense.

---

### FR-08 — Ledger

**BR-38** — The ledger is written **automatically**. No user posts a ledger line by hand.
Whenever money moves anywhere in the system, a ledger line writes itself.

**FR-08.1** — The following events post to the ledger:

| Event | Posts as | Source | Referenced by |
|-------|----------|--------|---------------|
| Payment received against a sale | **Credit** | Sale payment | Sale payment receipt number |
| Expense recorded | **Debit** | Expense | Expense reference |
| Payment made to a supplier | **Debit** | Supplier payment | Supplier payment receipt number |

**FR-08.1.1** — An entry's **type** and **source** are both references to managed lists
(FR-12.12), not stored values. The balance is computed from the entry type's direction
(FR-12.12.2), and neither list may gain or lose entries (BR-66).

**BR-39** — Ledger entries are **protected against duplication**. The same underlying
payment or expense cannot post twice, regardless of which code path created it — form
submission, customer-level allocation, or backfill.

**BR-40** — When a payment is edited, its ledger entry is updated to match. When a payment
is deleted, its ledger entry is removed. The ledger balance must always equal the sum of
the records behind it.

**FR-08.2** — The ledger page lists entries newest first with total credits, total debits,
and the current balance.

**FR-08.3** — The ledger can be rebuilt from existing records, with a preview mode that
reports what it would post before writing anything.

---

### FR-09 — Reports and exports

**FR-09.1** — Expenses by category for the current year, ranked by size.

**FR-09.2** — Current balance carried through from the ledger.

**FR-09.3** — **Full data export** to Excel: one sheet each for employees, customers,
inventory, expenses, and payments.

**FR-09.4** — **Customer financial summary** to Excel: every customer with total invoiced,
paid, and due, formatted with a grand-total row.

**FR-09.5** — Reports and the ledger are **manager-only**.

**FR-09.6** — Reports break down by shop, and shop is a column in the sales and customer exports
(FR-11.5.3). The ledger is not broken down by shop — see §10.2 for why, and what it costs.

---

### FR-10 — Administration

**FR-10.1** — Business name, logo, address, phone, and email are configured centrally and
appear across the interface and on every printed invoice and receipt.

**FR-10.2** — Setup commands exist to create the four standard role groups in one step, and
to grant a role its baseline permissions for customers, inventory, and expenses, or for sales.

#### FR-10.3 — Data cleanup

A tool exists to clear selected data, intended for resetting a test system. It is wrapped in
four independent safeguards:

**BR-41** — Restricted to superusers.

**BR-42** — Switched off by default in production; it must be deliberately enabled by
configuration.

**BR-43** — Requires typing an exact confirmation phrase before anything is deleted, and
offers a preview of exactly what would be removed.

**BR-44** — Administrator accounts are preserved unless explicitly selected. The account
currently signed in is protected by default, and overriding that protection requires a
second, different confirmation phrase.

---

## 5. Reference data

### RD-01 — Automatic identifiers

| Document | Format | Numbering |
|----------|--------|-----------|
| Customer | `FE19082026-01` | Creation date `DDMMYYYY`, then a continuous serial that never resets |
| Sale / invoice | `19-08-2026-FE-0001` | Creation date `DD-MM-YYYY`, then a continuous global serial that never resets |
| Sale payment receipt | `RCPT-20260819-A1B2C3` | Date plus random suffix, unique per payment |
| Customer payment batch | `CUSTPMT-20260819103045-A1B2C3` | Timestamp plus random suffix, unique per payment event |
| Supplier payment | `SPAY-20260819-A1B2C3` | Date plus random suffix, unique per payment |
| Employee | `EMP-A1B2C3D4` | Random, unique per account |

**BR-45** — All six identifier formats are **globally unique** and, once assigned, immutable.

**BR-46** — Customer and sale serials are **continuous** — they do not restart daily,
monthly, or annually. The date in the identifier is the creation date; the serial is
independent of it.

### RD-02 — Stock units
Pieces · Box · Kilogram · Litre · Metre
*Under FR-12.4.2 this is seed content for the `units` list, not a fixed set — extensible without
a code change. Codes `pcs`, `box`, `kg`, `ltr`, `mtr` remain stable (BR-59).*

### RD-03 — Sale states
Quotation · Draft · Finalised · Cancelled
*Under FR-12.8 this is seed content for the `statuses` list, scope `sale`. Codes `quote`, `draft`,
`finalized`, `cancelled` are load-bearing and immutable; labels are editable.*

### RD-04 — Customer payment methods
Cash · Bank transfer · Card · Cheque · Other
*Under FR-12.9 this is seed content for the `payment_methods` list, scope `customer`.*

### RD-05 — Expense categories
Salary · Utilities · Maintenance · Transport · Supplies · Rent · Marketing · Other
*Under FR-12.10 this is seed content for the `expense_categories` list, not a fixed set. Codes
`salary` … `other` remain stable (BR-59); labels are editable and the list is extensible.*

### RD-06 — Supplier payment methods
LC · Cheque · TT · Cash · Bank
*Under FR-12.9.2 this is seed content for the `payment_methods` list, scope `supplier`. The codes
`lc`, `check`, `tt`, `cash`, and `bank` are load-bearing — BR-29 reads them from the payment row
itself (BR-64) — and are immutable; labels are editable.*

### RD-07 — Stock movement types

| Code | Label | Direction |
|------|-------|-----------|
| `in` | Stock In | increases (+1) |
| `out` | Stock Out | decreases (−1) |
| `adjustment` | Adjustment | either (0) |

*Under FR-12.7 this is seed content for the `transaction_types` list. Labels are editable; codes
and directions are not, and no fourth type may be added without code to write and present it
(BR-61).*

### RD-08 — Claim states
Pending · Approved · Rejected
*Under FR-12.11 this is seed content for the `statuses` list, scope `claim`. The codes `pending`,
`approved`, and `rejected` are load-bearing — BR-35, BR-36, and BR-37 read them from the claim row
itself (BR-65) — and are immutable; labels are editable. No fourth state may be recorded
(FR-12.11.2).*

### RD-09 — Staff status
Active · Inactive · On leave
*Under FR-12.3 this is seed content for the `statuses` list, scope `user`. Codes `active`,
`inactive`, `on_leave` remain stable; `active` is the one application logic depends on.*

### RD-10 — Customer status
Active · Inactive
*Under FR-12.3 this is seed content for the `statuses` list, scope `customer`. A customer can
never take a staff-scoped status (BR-58).*

### RD-11 — Ledger entry types and sources

| Code | Label | Direction |
|------|-------|-----------|
| `credit` | Credit | increases the balance (+1) |
| `debit` | Debit | decreases the balance (−1) |

Sources: `sale_payment` Sale payment · `expense` Expense · `supplier_payment` Supplier payment ·
`other` Other

*Under FR-12.12 these are seed content for the `ledger_entry_types` and `ledger_sources` lists.
Labels are editable; codes and directions are not, and no entry may be added to or removed from
either list (BR-66). Neither code is copied onto the ledger row — nothing reads it from there
(FR-12.12.4).*

### RD-12 — Pagination

| List | Rows per page |
|------|---------------|
| Customers, inventory, expenses, sales, suppliers, ledger | 10 |
| Stock movement history | 20 |
| Shops | 10 |
| Reference lists (user types, positions, departments, statuses, categories, expense categories, units, transaction types, item types, payment methods, ledger entry types, ledger sources) | 25 |

### RD-13 — Shop status
Active · Inactive

### RD-14 — User types
Owner · Manager · Finance · Employee

| Type | Unrestricted | Manager |
|------|--------------|---------|
| Owner | yes | yes |
| Manager | no | yes |
| Finance | no | no |
| Employee | no | no |

*Seed content for the `user_types` list (FR-12.1). The two privilege columns are what the type
confers, and are read from the type — never copied onto the account (BR-56). Finance currently
confers no elevated privilege; it exists to classify staff and to hold permissions once §10.3 is
settled.*

### RD-15 — Expense payment methods
Cash · Bank transfer · Cheque · Card · Other
*Seed content for the `payment_methods` list, scope `expense` (FR-12.10.3). The column this
replaces was free text and was never validated, so the migration also harvests whatever distinct
values it already holds (FR-12.10.5) — see [DB_DESIGN.MD](DB_DESIGN.MD) §23.5.*

---

## 6. Non-functional requirements

### Data integrity

**NFR-01** — All monetary amounts are stored as exact decimals. Floating-point
representation of money is forbidden anywhere in the stack.

**NFR-02** — Quantities are stored to three decimal places; box counts as whole numbers.

**NFR-03** — Every multi-step money or stock operation runs inside a single database
transaction. Partial writes are never observable.

**NFR-04** — Concurrent operations against the same sale, customer, purchase, or supplier
are serialised by row-level locking so that balance checks cannot be raced.

**NFR-05** — All timestamps are stored with time zone information and displayed in
Asia/Dhaka.

### Security

**NFR-06** — Passwords are stored using a salted, computationally expensive one-way hash.

**NFR-07** — In production the application enforces HTTPS, secure and HTTP-only cookies,
HSTS, and clickjacking protection.

**NFR-08** — A content security policy limits where page content may load from, and
browser access to camera, microphone, location, and payment APIs is blocked outright.

**NFR-09** — Every state-changing request is protected against cross-site request forgery.

**NFR-10** — Login rate limiting is applied as described in FR-00.9 and FR-00.10.

**NFR-11** — Uploaded attachments are validated by extension (BR-34) and stored outside
the application's executable path.

**NFR-12** — Database dumps, `.env` files, and any other artefact containing credentials
or customer data must never be committed to version control.

### Performance and scale

**NFR-13** — The system targets a single organisation: thousands of customers, tens of
thousands of sales, hundreds of thousands of ledger entries. It is not designed for
multi-tenant scale.

**NFR-14** — Every list view is paginated (RD-12). No screen loads an unbounded result set.

**NFR-15** — Free-text search across customers, inventory, sales, and expenses must remain
responsive as those tables grow.

### Operations

**NFR-16** — The database of record is **PostgreSQL**. SQLite is acceptable for local
development only.

**NFR-17** — Schema changes are applied through versioned, reversible migrations, checked into
the repository. Data backfills are separated from structural changes so each can be rolled back
independently. Automatic schema synchronisation against a real database is forbidden — it drops
constraints the ORM does not model, and this schema has several (DB_DESIGN.MD §6).

**NFR-18** — The application deploys as a container behind a reverse proxy, with static
assets served independently of the application process.

---

## 7. Out of scope

The following are explicitly **not** required:

- Multi-currency and foreign exchange.
- Tax calculation, VAT handling, and discount rules.
- A machine catalogue — machines are one-off free-text lines and are never stocked.
- Integration with external accounting packages beyond spreadsheet export.
- Per-line payment allocation. Payments apply at the sale level.
- Customer-facing portals. All users are staff.
- **Stock transfer between shops.** Moving inventory from one shop to another is a real
  warehouse operation with its own paperwork and approval, not a field edit. Until it is
  specified, a shop's stock is adjusted only by its own sales and its own manual corrections
  (BR-54). The workaround — reduce quantity in one shop, increase it in another, both logged as
  adjustments — leaves an auditable trail but does not link the two halves.
- **Per-shop profit.** Revenue is shop-scoped but expenses are not, so gross margin per shop is
  available and net profit per shop is not. See §10.2.

---

## 8. Deferred

### 8.1 Superseded: the multi-showroom plan

[docs/MULTI_SHOWROOM_PLAN.md](docs/MULTI_SHOWROOM_PLAN.md) proposed a different answer to the
same problem and is **superseded by FR-11**. The two differ on the point that matters most:

| | MULTI_SHOWROOM_PLAN.md | **FR-11 (this document)** |
|---|---|---|
| Inventory | **Central and shared.** All showrooms draw from one warehouse pool. | **Per shop.** Each shop holds its own stock. |
| Product codes | Globally unique | **Unique per shop** (BR-51) |
| Customers | Global — may buy at any showroom | **Belong to one shop** (BR-49) |
| Expenses | Gain a showroom, `NULL` meaning central | Not scoped (FR-11.4) |
| Staff | Assigned to a showroom | Not scoped — see §10.1 |
| Sale numbering | Per showroom, restarting at 0001 | Unchanged: one continuous global series (BR-46) |

That plan should be marked superseded or deleted rather than left to be found and followed. Its
seven-step deployment sequence remains sound advice and is reused in
[DB_DESIGN.MD](DB_DESIGN.MD) §22.

**The inventory decision is the one to be sure about.** Per-shop stock means a product carried by
three shops is three records with three quantities, three prices, and three movement histories —
and no single number for "how many clips does the business own" without summing across shops. It
suits shops that buy and hold independently. It suits a central warehouse that distributes to
branches poorly, and moving back to a shared pool later is not a small migration.

### 8.2 Still deferred

- Stock transfers between shops (§7).
- Shop-scoped expenses, and therefore per-shop net profit (§10.2).

---

## 9. Known deviations

Points where the running system does not currently match the requirements above. Each is a
defect to be closed, not a change to the requirement.

| ID | Deviation |
|----|-----------|
| **D-01** | The Reports page still shows payment statistics sourced from a retired standalone payments module. No live code writes to it, so those figures are permanently zero. FR-09 does not require this panel; it should be removed. |
| **D-02** | The **Cancelled** sale state (RD-03) is defined and stored but no user interface transitions a sale into it. |
| **D-03** | The ledger's duplicate protection (BR-39) is enforced in application code only. It is not backed by a database constraint, so a race between two concurrent writers can produce a double post. See DB_DESIGN.MD §7. |
| **D-04** | An older standalone payments module remains in the codebase. Its menu entry and routes are switched off and it is superseded by the sales module. Its table should be retired. |
| **D-05** | *Resolved by FR-12.* An inventory item's supplier was stored as free text rather than a reference to the supplier record, so the buying and stock sides could not be joined. FR-04.1.1 makes it a reference. The migration cannot match every historical value automatically — see DB_DESIGN.MD §23.5. |
| **D-06** | The user responsible for a stock movement is stored as a copied username string rather than a reference to the account, so movements survive but become unattributable if the account is renamed. |

---

## 10. Open decisions — FR-11

Two questions FR-11 cannot answer from the request alone. Both change what gets built, so they
need an answer before implementation rather than a guess during it.

### 10.1 Do staff belong to a shop?

**The question.** When someone creates a customer, a product, or a sale, which shop does it
belong to — one they pick from a list every time, or their own shop, filled in automatically?

**Why it matters.** It decides three things at once: whether the shop field is a required choice
on every create form, whether a salesperson at the Gulshan branch can see and edit Dhanmondi's
stock, and whether BR-53 (a sale's customer must be from the same shop) is a helpful guard rail
or a daily obstruction.

| Option | What it means | Cost |
|--------|---------------|------|
| **A — No staff/shop link** *(what FR-11 currently specifies)* | Shop is picked on each create form. Everyone can work in any shop. | Nothing extra to build. Mis-filing is easy and nothing prevents it. |
| **B — Each account has a home shop** *(recommended)* | The form defaults to the user's shop; managers and superusers may override. Everyone still *sees* every shop. | One field on the user record, plus form defaulting. |
| **C — Home shop, and visibility restricted to it** | As B, and staff cannot see other shops' data at all. Managers see their shop; superusers see all. | B, plus a scoping rule on every list, detail page, and export — comparable in size to BR-01, and it interacts with it. |

**Recommendation: B.** It removes the most common error — recording a sale against the wrong shop
— without the reach of C. C is a genuine access-control change and deserves to be requested
explicitly rather than absorbed into a data-model feature; if the shops distrust each other's
staff, say so and it becomes a separate piece of work.

**BR-55** — *(conditional on choosing B or C)* An account's home shop determines the default shop
on every create form. Under C it additionally limits which records the account can read.

### 10.2 Should expenses be shop-scoped?

**The question.** FR-11 scopes customers, inventory, and sales, as asked. Expenses were not
mentioned.

**Why it matters.** Without it, per-shop **net profit** cannot be calculated. Revenue is
shop-scoped, so gross figures per shop work; but rent, salaries, and utilities sit in one
undivided pool, so "did the Gulshan branch make money last month" has no answer.

If per-shop profitability is the reason for wanting shops at all, this needs to be in scope now —
retro-fitting a shop onto historical expenses means somebody hand-classifying every past row.

**Recommendation:** add a **nullable** `shop` to expenses, where `NULL` means a business-wide
cost that belongs to no single shop (head office rent, the accountant's fee). Nullable is the
important part: forcing every expense onto a shop would be worse than not scoping them, because
it invites arbitrary allocation of costs that genuinely are shared. This mirrors what
MULTI_SHOWROOM_PLAN.md proposed and is the one part of that plan worth keeping.

### 10.3 What replaces the permission system?

**The question.** §3.2 describes three authorisation mechanisms. Two of them — per-record
permissions and the synthetic "menu" permissions — are Django's permission framework, which does
not exist on NestJS. Only the third, user type, has a design (FR-12.1, DB_DESIGN.MD §23.3).

**Why it matters.** Almost every requirement in this document is gated by one of them: `add_sale`,
`finalize_sale`, `review_bills`, `change_expense`, `view_reports_menu`, and roughly thirty more.
"Manager-only" (BR-33, FR-09.5) is covered by the user type; the rest are not. Without a
replacement, the rebuild either grants everything to everyone or hard-codes checks one by one.

**What already exists to work from.** The legacy database holds the full picture — which groups
exist, which permissions each carries, and which users belong to which group. Export it before
dropping those tables; DB_DESIGN.MD §21 has the query.

| Option | What it means | Cost |
|--------|---------------|------|
| **A — Type only** | Four types with fixed, hard-coded capabilities. No per-permission grants. | Smallest. Loses the ability to grant one person one extra capability — which the current system is actively used for. |
| **B — Permissions on the type** *(recommended)* | A `permissions` table and a `user_type_permissions` join. Capability is a property of the type; assigning a person a type grants the set. | Moderate. Covers every current use except per-user exceptions. |
| **C — Roles separate from types, plus per-user grants** | Full reproduction of the current model: types classify, roles bundle permissions, users hold several roles plus individual overrides. | Largest. Matches today's flexibility exactly, including its complexity. |

**Recommendation: B**, unless the exported grants show per-user exceptions actually in use — check
before deciding. B keeps one thing true that the current system does not: **there is exactly one
place to look** to find out why someone can do something. The existing three overlapping
mechanisms are a recurring source of confusion, and a rebuild is the one chance to not carry that
forward.

Whichever is chosen, keep the **permission codenames** from the legacy export. They are already
referenced throughout this document, and reusing them keeps every requirement here traceable to
the thing that enforces it.
