import { Type } from 'class-transformer';
import { IsInt, IsOptional, Min } from 'class-validator';

/**
 * RD-12 — every list view is paginated and no screen loads an unbounded result
 * set (NFR-14). The page sizes are fixed by the requirement, so they live here
 * rather than being repeated as magic numbers in each controller.
 */
export const PAGE_SIZE = {
  customers: 10,
  inventory: 10,
  expenses: 10,
  sales: 10,
  suppliers: 10,
  ledger: 10,
  shops: 10,
  stockHistory: 20,
  reference: 25,
} as const;

export type PageSizeKey = keyof typeof PAGE_SIZE;

export class PaginationQuery {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number;

  get pageNumber(): number {
    return this.page && this.page > 0 ? this.page : 1;
  }

  skipFor(key: PageSizeKey): number {
    return (this.pageNumber - 1) * PAGE_SIZE[key];
  }
}

export interface Page<T> {
  items: T[];
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
}

export function toPage<T>(
  items: T[],
  total: number,
  page: number,
  pageSize: number,
): Page<T> {
  return {
    items,
    page,
    pageSize,
    total,
    totalPages: total === 0 ? 0 : Math.ceil(total / pageSize),
  };
}
