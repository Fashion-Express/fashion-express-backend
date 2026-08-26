import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, EntityManager } from 'typeorm';
import { firstRow, rowsOf } from '../../common/sql';

/**
 * FR-08 — the ledger writes itself.
 *
 * BR-38: no user posts a ledger line by hand. Whenever money moves anywhere in
 * the system, a line writes itself — so every money path calls this service
 * inside its own transaction, and the ledger cannot drift from the records
 * behind it.
 *
 * This is the *posting* half of FR-08. The reading half — the ledger screen,
 * the running balance, the rebuild command (FR-08.2, FR-08.3) — is a later
 * phase. It is here now because supplier payments move money, and shipping a
 * payment path that quietly failed to post would be a defect with no symptom
 * until someone reconciled by hand.
 */

/** RD-11 — the four sources. Fixed: the list cannot gain entries (BR-66). */
export type LedgerSourceCode =
  'sale_payment' | 'expense' | 'supplier_payment' | 'other';

export type LedgerEntryTypeCode = 'credit' | 'debit';

@Injectable()
export class LedgerService {
  /**
   * Six rows that never change (BR-66), so they are resolved once and cached
   * rather than looked up on every post (§23.6).
   */
  private types = new Map<string, string>();
  private sources = new Map<string, string>();

  constructor(@InjectDataSource() private readonly dataSource: DataSource) {}

  private async ids(): Promise<void> {
    if (this.types.size > 0) return;
    for (const row of rowsOf<{ id: string; code: string }>(
      await this.dataSource.query(
        `SELECT id::text, code FROM ledger_entry_types`,
      ),
    )) {
      this.types.set(row.code, row.id);
    }
    for (const row of rowsOf<{ id: string; code: string }>(
      await this.dataSource.query(`SELECT id::text, code FROM ledger_sources`),
    )) {
      this.sources.set(row.code, row.id);
    }
  }

  /**
   * Post one line, idempotently.
   *
   * BR-39 — the same underlying payment or expense cannot post twice, whatever
   * code path created it. `ON CONFLICT DO NOTHING` over the partial unique
   * index `(source_id, reference)` is what makes that true even when two
   * transactions race: the second simply writes nothing. It is also one round
   * trip instead of the read-then-write that the rule used to rely on.
   *
   * Returns whether a row was actually written, which the rebuild command
   * (FR-08.3) needs in order to report what it did.
   */
  async post(
    manager: EntityManager,
    entry: {
      entryType: LedgerEntryTypeCode;
      source: LedgerSourceCode;
      reference: string;
      amount: string;
      description: string;
      timestamp?: Date;
    },
  ): Promise<boolean> {
    await this.ids();

    const inserted: unknown = await manager.query(
      `INSERT INTO ledger_entries (timestamp, entry_type_id, source_id,
                                   reference, description, amount)
       VALUES (COALESCE($1, now()), $2, $3, $4, $5, $6)
       ON CONFLICT (source_id, reference) WHERE reference <> '' DO NOTHING
       RETURNING id::text`,
      [
        entry.timestamp ?? null,
        this.types.get(entry.entryType),
        this.sources.get(entry.source),
        entry.reference,
        entry.description,
        entry.amount,
      ],
    );

    return firstRow(inserted) !== undefined;
  }

  /**
   * BR-40 — when a payment is edited its ledger entry is updated to match; when
   * it is deleted the entry is removed. The ledger balance must always equal
   * the sum of the records behind it.
   */
  async updateAmount(
    manager: EntityManager,
    source: LedgerSourceCode,
    reference: string,
    amount: string,
    description?: string,
  ): Promise<void> {
    await this.ids();
    await manager.query(
      `UPDATE ledger_entries
          SET amount = $1,
              description = COALESCE($2, description)
        WHERE source_id = $3 AND reference = $4`,
      [amount, description ?? null, this.sources.get(source), reference],
    );
  }

  async remove(
    manager: EntityManager,
    source: LedgerSourceCode,
    reference: string,
  ): Promise<void> {
    await this.ids();
    await manager.query(
      `DELETE FROM ledger_entries WHERE source_id = $1 AND reference = $2`,
      [this.sources.get(source), reference],
    );
  }

  /**
   * FR-12.12.2 — the balance is arithmetic over `direction`, not a comparison
   * against the literal 'credit'. One scan, and the definition of "credit"
   * lives in one row of one table.
   */
  async balance(): Promise<string> {
    const row = firstRow<{ balance: string }>(
      await this.dataSource.query(
        `SELECT COALESCE(SUM(e.amount * t.direction), 0)::text AS balance
           FROM ledger_entries e
           JOIN ledger_entry_types t ON t.id = e.entry_type_id`,
      ),
    );
    return row?.balance ?? '0';
  }
}
