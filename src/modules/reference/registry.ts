/**
 * FR-12 — the twelve business-managed vocabularies, described once.
 *
 * DB_DESIGN.MD §23.1 makes the point that these lists share a shape, and that
 * "the pattern is the point". Twelve near-identical controllers would be twelve
 * places for the rules to drift apart, so instead each list is *described* here
 * and one service applies the rules to all of them.
 *
 * The list name in a URL is looked up in this registry and never interpolated
 * into SQL from the request — the registry is the whitelist.
 *
 * Three tiers, and the difference between them is the whole of FR-12.5:
 *
 *  - **named** — job positions, departments, categories. A `name` and nothing
 *    to keep stable, because no logic is keyed on them (§23.1).
 *  - **coded** — a stable `code` that application logic and history key on,
 *    plus a freely editable `label`. The code is fixed once created (BR-59).
 *  - **structural** — stock movement types, ledger entry types, ledger sources.
 *    Label editing only: no create, no delete, no deactivate (BR-61, BR-66).
 *    The system is the sole writer of the records that use them, so an entry
 *    nobody can write would sit in the list for ever without ever appearing on
 *    a record.
 */

export type ListKind = 'named' | 'coded' | 'structural';

export interface ReferenceList {
  /** URL segment and stable identifier for this list. */
  readonly slug: string;
  readonly table: string;
  readonly kind: ListKind;
  /** Shown on the administration screen. */
  readonly label: string;
  /**
   * The requirement this list implements. Internal traceability only — it is
   * deliberately not part of any response, and never quoted in a message.
   */
  readonly requirement: string;
  /**
   * Scoped lists are several independent vocabularies sharing a table, kept
   * apart by a `scope` column (§23.2 for statuses, §23.1 for payment methods).
   * A scope is required on create and may be filtered on read.
   */
  readonly scopes?: readonly string[];
  /** Columns beyond the shared shape, editable unless listed in `readOnly`. */
  readonly extraColumns?: readonly string[];
  /** Columns that exist but may never be written through this module. */
  readonly readOnly?: readonly string[];
  /**
   * Tables that reference this list but are part of the entry ITSELF rather
   * than a record depending on it, so BR-60's "in use" count must ignore them.
   *
   * Without this a user type that had been given permissions reported its own
   * grant rows as usage: a role nobody held refused to be deleted, saying it
   * was "used by 13 records" — the 13 being its own permissions, which the
   * foreign key would have cascaded away anyway.
   */
  readonly usageExcludes?: readonly string[];
  readonly hasDescription?: boolean;
  readonly hasSortOrder?: boolean;
  /** Anything a caller should be told before editing. */
  readonly note?: string;
}

export const REFERENCE_LISTS: readonly ReferenceList[] = [
  // ---- named ---------------------------------------------------------
  {
    slug: 'job-positions',
    table: 'job_positions',
    kind: 'named',
    label: 'Job positions',
    requirement: 'FR-12.2',
    note: 'Optional on a staff account; existing accounts without one stay valid.',
  },
  {
    slug: 'departments',
    table: 'departments',
    kind: 'named',
    label: 'Departments',
    requirement: 'FR-12.2',
    note: 'Optional on a staff account.',
  },
  {
    slug: 'categories',
    table: 'categories',
    kind: 'named',
    label: 'Product categories',
    requirement: 'FR-12.4.1',
    hasDescription: true,
    note:
      'Shared across all shops. Inventory is shop-scoped; its taxonomy is not — ' +
      'two shops selling fasteners are selling the same kind of thing.',
  },

  // ---- coded ---------------------------------------------------------
  {
    slug: 'units',
    table: 'units',
    kind: 'coded',
    label: 'Units of measure',
    requirement: 'FR-12.4.2 (RD-02)',
    hasSortOrder: true,
    note: 'Extensible without a code change. Unit is required on every product.',
  },
  {
    slug: 'expense-categories',
    table: 'expense_categories',
    kind: 'coded',
    label: 'Expense categories',
    requirement: 'FR-12.10 (RD-05)',
    hasSortOrder: true,
    note:
      'Nothing branches on which category an expense carries, so the business ' +
      'owns this outright. The code is kept only so that renaming a label does ' +
      'not re-file years of history.',
  },
  {
    slug: 'statuses',
    table: 'statuses',
    kind: 'coded',
    label: 'Statuses',
    requirement: 'FR-12.3 (RD-03, RD-08, RD-09, RD-10)',
    scopes: ['user', 'customer', 'sale', 'claim'],
    hasSortOrder: true,
    note:
      'Four independent lists sharing one table. A status may only be used by ' +
      'the entity type it is scoped to. Adding a sale status is allowed ' +
      'but reaches nothing; adding a claim status is refused at the ' +
      'point of use.',
  },
  {
    slug: 'payment-methods',
    table: 'payment_methods',
    kind: 'coded',
    label: 'Payment methods',
    requirement: 'FR-12.9 (RD-04, RD-06, RD-15)',
    scopes: ['customer', 'supplier', 'expense'],
    hasSortOrder: true,
    note:
      'Three independent lists sharing one table, which is what keeps ' +
      'a supplier-only method such as LC off a customer receipt. A new supplier ' +
      'method fails safe: `cash` alone is exempt, so anything else requires ' +
      'a reference number.',
  },
  {
    slug: 'item-types',
    table: 'item_types',
    kind: 'coded',
    label: 'Sale line item types',
    requirement: 'FR-12.8.2',
    hasSortOrder: true,
    note:
      'Adding a third type is permitted here but refused at the point of ' +
      'use: an item type is a choice between two differently shaped ' +
      'records — one drawing on stock, one free text — so a third kind must be ' +
      'built, not listed.',
  },
  {
    slug: 'user-types',
    table: 'user_types',
    kind: 'coded',
    label: 'User types',
    requirement: 'FR-12.1 (RD-14)',
    hasDescription: true,
    hasSortOrder: true,
    extraColumns: ['is_superuser', 'is_manager'],
    // Its own grants, not records that depend on it — and ON DELETE CASCADE
    // removes them with the type.
    usageExcludes: ['user_type_permissions'],
    note:
      'A type declares the privilege it confers, and that privilege is read ' +
      'from the type on every request — so changing these flags ' +
      'changes what every holder may do, immediately.',
  },

  // ---- structural ----------------------------------------------------
  {
    slug: 'transaction-types',
    table: 'transaction_types',
    kind: 'structural',
    label: 'Stock movement types',
    requirement: 'FR-12.7 (RD-07)',
    hasSortOrder: true,
    extraColumns: ['direction'],
    readOnly: ['direction'],
    note:
      'Label editing only. Stock movements are written only by the ' +
      'system, so a type nobody can write would never appear on a record. ' +
      '`direction` drives the +/- sign in the movement history and is fixed.',
  },
  {
    slug: 'ledger-entry-types',
    table: 'ledger_entry_types',
    kind: 'structural',
    label: 'Ledger entry types',
    requirement: 'FR-12.12.1 (RD-11)',
    hasSortOrder: true,
    extraColumns: ['direction'],
    readOnly: ['direction'],
    note:
      'Label editing only. `direction` is +1 for a credit and -1 for a ' +
      'debit, and the running balance is computed from it — this is the one ' +
      'piece of arithmetic that defines the balance.',
  },
  {
    slug: 'ledger-sources',
    table: 'ledger_sources',
    kind: 'structural',
    label: 'Ledger sources',
    requirement: 'FR-12.12.3 (RD-11)',
    hasSortOrder: true,
    note:
      'Label editing only. The ledger is written only by the system, ' +
      'and every writer targets one of these four.',
  },
];

const BY_SLUG = new Map(REFERENCE_LISTS.map((l) => [l.slug, l]));

export function findList(slug: string): ReferenceList | undefined {
  return BY_SLUG.get(slug);
}

/** What the caller may do with a list — drives FR-12.5.2's reduced screens. */
export function capabilitiesOf(list: ReferenceList): {
  create: boolean;
  delete: boolean;
  deactivate: boolean;
  editableFields: string[];
} {
  if (list.kind === 'structural') {
    return {
      create: false,
      delete: false,
      deactivate: false,
      editableFields: ['label'],
    };
  }

  const editable =
    list.kind === 'named'
      ? ['name', ...(list.hasDescription ? ['description'] : [])]
      : ['label', ...(list.hasDescription ? ['description'] : [])];

  if (list.hasSortOrder) editable.push('sortOrder');
  for (const column of list.extraColumns ?? []) {
    if (!(list.readOnly ?? []).includes(column)) {
      editable.push(column.replace(/_(.)/g, (_, c: string) => c.toUpperCase()));
    }
  }
  editable.push('isActive');

  // The code is never editable, on any list (BR-59).
  return {
    create: true,
    delete: true,
    deactivate: true,
    editableFields: editable,
  };
}
