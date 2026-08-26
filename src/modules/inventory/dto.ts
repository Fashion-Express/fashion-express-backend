import { Type } from 'class-transformer';
import { ToBoolean } from '../../common/to-boolean';
import {
  IsBoolean,
  IsInt,
  IsNumberString,
  IsOptional,
  IsString,
  Length,
  Min,
} from 'class-validator';

/**
 * FR-04.1 — the product record.
 *
 * Quantities and money are decimal **strings** (NFR-01, NFR-02): quantity is
 * held to three decimal places so part units measure cleanly, and a JSON number
 * is a float.
 */
export class CreateInventoryItemDto {
  @IsString() @Length(1, 50) partCode!: string;
  @IsString() @Length(1, 200) partName!: string;

  /** BR-49 — every item belongs to exactly one shop. */
  @IsNumberString() shopId!: string;

  /** FR-04.1.2 — unit is required; a quantity without one is meaningless. */
  @IsNumberString() unitId!: string;

  /** FR-04.1.2 — category and supplier are optional. */
  @IsOptional() @IsNumberString() categoryId?: string;
  @IsOptional() @IsNumberString() supplierId?: string;

  @IsOptional() @IsString() description?: string;
  @IsOptional() @IsString() @Length(0, 100) location?: string;

  @IsOptional()
  @IsNumberString({}, { message: 'quantity must be a decimal string' })
  quantity?: string;
  @IsOptional() @Type(() => Number) @IsInt() @Min(0) boxCount?: number;

  /** BR-22 — cost and selling price are stored separately so margin stays visible. */
  @IsOptional() @IsNumberString() purchasePrice?: string;
  @IsOptional() @IsNumberString() unitPrice?: string;

  @IsOptional() @Type(() => Number) @IsInt() @Min(0) minimumStock?: number;
}

/**
 * `partCode` is editable — it is unique per shop (BR-51), not an immutable
 * identifier like a customer number. `shopId` is not: BR-54 fixes a record's
 * shop at creation, and moving stock between shops is a transfer, explicitly
 * out of scope (§7).
 */
export class UpdateInventoryItemDto {
  @IsOptional() @IsString() @Length(1, 50) partCode?: string;
  @IsOptional() @IsString() @Length(1, 200) partName?: string;
  @IsOptional() @IsNumberString() unitId?: string;
  @IsOptional() @IsNumberString() categoryId?: string;
  @IsOptional() @IsNumberString() supplierId?: string;
  @IsOptional() @IsString() description?: string;
  @IsOptional() @IsString() @Length(0, 100) location?: string;
  @IsOptional() @IsNumberString() quantity?: string;
  @IsOptional() @Type(() => Number) @IsInt() @Min(0) boxCount?: number;
  @IsOptional() @IsNumberString() purchasePrice?: string;
  @IsOptional() @IsNumberString() unitPrice?: string;
  @IsOptional() @Type(() => Number) @IsInt() @Min(0) minimumStock?: number;
}

export class ListInventoryQuery {
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) page?: number;
  /** FR-04.3 — by product name, code or category. */
  @IsOptional() @IsString() search?: string;
  @IsOptional() @IsNumberString() shopId?: string;
  @IsOptional() @IsNumberString() categoryId?: string;
  /** FR-04.3 — show only items running low (BR-24). */
  @IsOptional() @ToBoolean() @IsBoolean() lowStock?: boolean;
}
