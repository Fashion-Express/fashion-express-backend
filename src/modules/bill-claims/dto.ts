import { Type } from 'class-transformer';
import {
  IsDateString,
  IsIn,
  IsInt,
  IsNumberString,
  IsOptional,
  IsString,
  Length,
  Min,
} from 'class-validator';

/** FR-07.1 — a claim carries an amount, a description and the bill date. */
export class CreateBillClaimDto {
  @IsNumberString({}, { message: 'amount must be a decimal string' })
  amount!: string;
  @IsString() @Length(1) description!: string;
  @IsDateString() billDate!: string;
}

/**
 * Note what is absent: `status`, `approvedBy`, `approvalDate`, `expenseId`.
 *
 * FR-07.1.1 — a claim's status "is set by the approval workflow and is never
 * typed or chosen freely". The workflow owns all four, and
 * `billclaim_review_consistent` makes any other combination unrepresentable.
 */
export class UpdateBillClaimDto {
  @IsOptional() @IsNumberString() amount?: string;
  @IsOptional() @IsString() @Length(1) description?: string;
  @IsOptional() @IsDateString() billDate?: string;
}

export class ReviewBillClaimDto {
  /** The expense category the approved claim is filed under (BR-36). */
  @IsOptional() @IsNumberString() expenseCategoryId?: string;
  @IsOptional() @IsString() notes?: string;
}

export class ListBillClaimsQuery {
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) page?: number;
  @IsOptional() @IsIn(['pending', 'approved', 'rejected']) status?: string;
  /** FR-07.4 — managers search by staff name or description. */
  @IsOptional() @IsString() search?: string;
  @IsOptional() @IsNumberString() userId?: string;
}
