# Out of scope

**Every functional requirement in `REQUIREMENTS.MD` is implemented.** What
follows is what the specification deliberately excludes, recorded so it is not
mistaken for an omission.

## Explicitly out of scope (§7)

- **Multi-currency and foreign exchange.** One currency, Bangladeshi Taka.
- **Tax, VAT and discount rules.** No line or document carries either.
- **A machine catalogue.** Machines are one-off free-text lines and are never
  stocked — which is why a sale line is two structurally different records
  sharing a table (BR-04).
- **Integration with accounting packages** beyond spreadsheet export.
- **Per-line payment allocation.** Payments apply at the sale level.
- **Customer-facing portals.** Every user is staff.
- **Stock transfer between shops** (BR-54). Moving inventory between shops is a
  real warehouse operation with its own paperwork and approval, not a field
  edit. The workaround — reduce in one shop, increase in the other, both logged
  as adjustments — leaves an auditable trail but does not link the two halves.
- **Per-shop net profit.** Revenue is shop-scoped and expenses carry an optional
  shop, so gross margin per shop is available and net profit is not. Attributing
  shared costs would be arbitrary; see `reports.md`.

## Known deviations closed by this build (§9)

| | |
|---|---|
| **D-01** | The retired payments panel never existed here. |
| **D-02** | The `cancelled` state is reachable — `PATCH /api/sales/:id` accepts it. |
| **D-03** | BR-39 is a database constraint, not application code. |
| **D-04** | The old standalone payments table was never carried over. |
| **D-05** | An inventory item's supplier is a foreign key (FR-04.1.1). |
| **D-06** | `stock_histories.created_by_id` is a foreign key, not a copied name. |

## Open questions that were decided

`REQUIREMENTS.MD` §10 left three questions open. All three were answered before
implementation and the answers are recorded in the root `README.md`:

- **§10.1** staff have a home shop that defaults create forms, without
  restricting visibility (option B).
- **§10.2** expenses carry a nullable shop, so `NULL` means business-wide.
- **§10.3** permissions belong to the user type (option B).
