import { Type } from 'class-transformer';
import {
  IsIn,
  IsInt,
  IsNumberString,
  IsOptional,
  IsString,
  Length,
  Min,
} from 'class-validator';

/** FR-03.1 — the customer record. */
export class CreateCustomerDto {
  @IsString() @Length(1, 200) name!: string;
  @IsString() @Length(1, 20) phone!: string;

  /** BR-49 — every customer belongs to exactly one shop; there is no unassigned state. */
  @IsNumberString() shopId!: string;

  @IsOptional() @IsString() @Length(0, 200) company?: string;
  @IsOptional() @IsString() @Length(0, 254) email?: string;
  @IsOptional() @IsString() address?: string;
  @IsOptional() @IsString() @Length(0, 100) city?: string;
  @IsOptional() @IsString() notes?: string;

  /** RD-10 — customers have two statuses. Defaults to `active`. */
  @IsOptional() @IsIn(['active', 'inactive']) statusCode?: string;
}

/**
 * Note what is absent: `customerId` and `shopId`.
 *
 * The customer number is issued on creation and never editable (FR-03.2,
 * BR-45), and BR-54 fixes a record's shop at creation — reassigning a customer
 * to a different shop is not supported, because their sales are scoped to the
 * same shop (BR-53) and would be left behind.
 */
export class UpdateCustomerDto {
  @IsOptional() @IsString() @Length(1, 200) name?: string;
  @IsOptional() @IsString() @Length(1, 20) phone?: string;
  @IsOptional() @IsString() @Length(0, 200) company?: string;
  @IsOptional() @IsString() @Length(0, 254) email?: string;
  @IsOptional() @IsString() address?: string;
  @IsOptional() @IsString() @Length(0, 100) city?: string;
  @IsOptional() @IsString() notes?: string;
  @IsOptional() @IsIn(['active', 'inactive']) statusCode?: string;
}

export class ListCustomersQuery {
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) page?: number;
  /** FR-03.3 — across name, customer ID, company and phone. */
  @IsOptional() @IsString() search?: string;
  @IsOptional() @IsIn(['active', 'inactive']) statusCode?: string;
  /** FR-11.5.1 — the shop filter every list gains. */
  @IsOptional() @IsNumberString() shopId?: string;
}
