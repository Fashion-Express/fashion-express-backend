import { Type } from 'class-transformer';
import {
  IsDateString,
  IsInt,
  IsNumberString,
  IsOptional,
  IsString,
  Length,
  Matches,
  Min,
} from 'class-validator';

/**
 * FR-06.1 — an expense records date, category, description, amount, payee,
 * receipt number, payment method and notes.
 *
 * Category is **required** and payment method is **optional**: every expense is
 * classified, but not every expense records the instrument it was settled with
 * (FR-12.10.3).
 */
export class CreateExpenseDto {
  @IsDateString() date!: string;
  @IsNumberString({}, { message: 'amount must be a decimal string' })
  amount!: string;
  @IsString() @Length(1) description!: string;

  /** From the managed list (FR-12.10.1), not free text. */
  @IsNumberString() expenseCategoryId!: string;

  /** Optional, and must be `expense`-scoped when given (BR-62). */
  @IsOptional() @IsNumberString() paymentMethodId?: string;

  @IsOptional() @IsString() @Length(0, 200) paidTo?: string;
  @IsOptional() @IsString() @Length(0, 100) receiptNumber?: string;
  @IsOptional() @IsString() notes?: string;

  /**
   * REQUIREMENTS.MD §10.2 — nullable on purpose. `NULL` means a business-wide
   * cost that belongs to no single shop (head office rent, the accountant's
   * fee). Forcing every expense onto a shop would invite arbitrary allocation
   * of costs that genuinely are shared.
   */
  @IsOptional() @IsNumberString() shopId?: string;
}

export class UpdateExpenseDto {
  @IsOptional() @IsDateString() date?: string;
  @IsOptional() @IsNumberString() amount?: string;
  @IsOptional() @IsString() @Length(1) description?: string;
  @IsOptional() @IsNumberString() expenseCategoryId?: string;
  @IsOptional() @IsNumberString() paymentMethodId?: string;
  @IsOptional() @IsString() @Length(0, 200) paidTo?: string;
  @IsOptional() @IsString() @Length(0, 100) receiptNumber?: string;
  @IsOptional() @IsString() notes?: string;
  @IsOptional() @IsNumberString() shopId?: string;
}

export class ListExpensesQuery {
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) page?: number;

  /** FR-06.3 — across description, payee and receipt number. */
  @IsOptional() @IsString() search?: string;

  @IsOptional() @IsNumberString() expenseCategoryId?: string;
  @IsOptional() @IsNumberString() shopId?: string;

  /**
   * FR-06.4 — a whole month, a single date, or a range.
   *
   * **An explicit date range takes precedence over a month filter**, so sending
   * both is not ambiguous: `from`/`to` win and `month` is ignored.
   */
  @IsOptional()
  @Matches(/^\d{4}-\d{2}$/, { message: 'month must be YYYY-MM' })
  month?: string;
  @IsOptional() @IsDateString() date?: string;
  @IsOptional() @IsDateString() from?: string;
  @IsOptional() @IsDateString() to?: string;
}
