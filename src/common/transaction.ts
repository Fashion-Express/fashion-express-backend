import { Injectable, Logger } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, EntityManager } from 'typeorm';
import { loadEnv } from '../config/env';

/**
 * NFR-03 — every multi-step money or stock operation runs inside a single
 * database transaction. NFR-04 — concurrent operations against the same sale,
 * customer, purchase, or supplier are serialised by row-level locking.
 *
 * DB_DESIGN.MD §16 fixes the lock order and warns why it matters: the customer
 * payment allocator and the single-payment path both touch sale and customer
 * rows, so two code paths taking them in opposite orders is the classic recipe
 * for a deadlock. The ranks below encode that order once, and `lockRow`
 * complains in development if a transaction ever takes them out of sequence.
 *
 * Parents before children, always:
 *   customers / suppliers  ->  sales / supplier_purchases  ->  payment rows
 */
export const LOCK_RANK: Record<string, number> = {
  customers: 10,
  suppliers: 10,
  sales: 20,
  supplier_purchases: 20,
  sale_payments: 30,
  supplier_purchase_payments: 30,
  customer_payment_batches: 30,
  // Identifier counters are taken last and held for microseconds (§7.2).
  customer_id_sequences: 90,
  sale_id_sequences: 90,
};

const LOCK_STATE = Symbol('feLockState');

interface LockState {
  highestRank: number;
  taken: string[];
}

@Injectable()
export class TransactionService {
  private readonly logger = new Logger(TransactionService.name);

  constructor(@InjectDataSource() private readonly dataSource: DataSource) {}

  /**
   * Run `fn` inside one transaction. Every write in a money or stock operation
   * must go through the `EntityManager` handed to the callback — a repository
   * obtained elsewhere runs on its own connection and will not be part of it.
   */
  async run<T>(fn: (manager: EntityManager) => Promise<T>): Promise<T> {
    return this.dataSource.transaction(async (manager) => {
      (manager as never as Record<symbol, LockState>)[LOCK_STATE] = {
        highestRank: 0,
        taken: [],
      };
      return fn(manager);
    });
  }

  /**
   * `READ COMMITTED` is PostgreSQL's default and is what the locking strategy
   * above assumes. Use this only where a genuinely serialisable view is needed;
   * callers must be prepared to retry on SQLSTATE 40001.
   */
  async runSerializable<T>(
    fn: (manager: EntityManager) => Promise<T>,
  ): Promise<T> {
    return this.dataSource.transaction('SERIALIZABLE', async (manager) => {
      (manager as never as Record<symbol, LockState>)[LOCK_STATE] = {
        highestRank: 0,
        taken: [],
      };
      return fn(manager);
    });
  }
}

/**
 * Take a `FOR UPDATE` lock on one row, in the order §16 requires.
 *
 * Returns the locked row, or `undefined` if it does not exist — callers should
 * treat that as a 404 rather than proceeding against nothing.
 */
export async function lockRow<T extends object = Record<string, unknown>>(
  manager: EntityManager,
  table: string,
  id: string | number,
): Promise<T | undefined> {
  assertLockOrder(manager, table);
  const rows: T[] = await manager.query(
    `SELECT * FROM ${table} WHERE id = $1 FOR UPDATE`,
    [id],
  );
  return rows[0];
}

/**
 * Lock several rows of one table at once, ordered by id so that two
 * transactions locking overlapping sets cannot deadlock against each other.
 * This is the shape the FIFO allocators need (BR-20, BR-31).
 */
export async function lockRows<T extends object = Record<string, unknown>>(
  manager: EntityManager,
  table: string,
  ids: Array<string | number>,
): Promise<T[]> {
  if (ids.length === 0) return [];
  assertLockOrder(manager, table);
  return manager.query(
    `SELECT * FROM ${table} WHERE id = ANY($1) ORDER BY id FOR UPDATE`,
    [ids],
  );
}

function assertLockOrder(manager: EntityManager, table: string): void {
  const state = (manager as never as Record<symbol, LockState | undefined>)[
    LOCK_STATE
  ];
  // Locks taken outside TransactionService.run are not tracked; that is a
  // separate mistake and `FOR UPDATE` outside a transaction is a no-op anyway.
  if (!state) return;

  const rank = LOCK_RANK[table];
  if (rank === undefined) return;

  if (rank < state.highestRank && loadEnv().NODE_ENV !== 'production') {
    new Logger('LockOrder').warn(
      `Lock order violation: locking "${table}" (rank ${rank}) after ` +
        `[${state.taken.join(', ')}]. DB_DESIGN.MD §16 requires ` +
        `customer/supplier first, then children. This risks a deadlock.`,
    );
  }

  state.highestRank = Math.max(state.highestRank, rank);
  state.taken.push(table);
}
