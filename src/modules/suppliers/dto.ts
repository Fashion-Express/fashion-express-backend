import { Type } from 'class-transformer';
import {
  IsDateString,
  IsInt,
  IsNumberString,
  IsOptional,
  IsString,
  Length,
  Min,
} from 'class-validator';

/** FR-05.1 — suppliers are not shop-scoped: buying is done centrally (FR-11.4). */
export class CreateSupplierDto {
  @IsString() @Length(1, 200) name!: string;
  @IsString() @Length(1, 20) phone!: string;
  @IsOptional() @IsString() address?: string;
  @IsOptional() @IsString() @Length(0, 254) email?: string;
}

export class UpdateSupplierDto {
  @IsOptional() @IsString() @Length(1, 200) name?: string;
  @IsOptional() @IsString() @Length(1, 20) phone?: string;
  @IsOptional() @IsString() address?: string;
  @IsOptional() @IsString() @Length(0, 254) email?: string;
}

export class ListSuppliersQuery {
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) page?: number;
  /** FR-05.2 — searchable by name or phone. */
  @IsOptional() @IsString() search?: string;
}

/**
 * FR-05.3 — a purchase records the product description, price, date and notes.
 *
 * `productName` is free text, deliberately: a purchase is not linked to an
 * inventory item. Money is a decimal string throughout (NFR-01).
 */
export class CreatePurchaseDto {
  @IsString() @Length(1, 200) productName!: string;
  @IsNumberString({}, { message: 'price must be a decimal string' })
  price!: string;
  @IsDateString() purchaseDate!: string;
  @IsOptional() @IsString() notes?: string;

  /**
   * BR-32 — an initial payment entered with the purchase may not exceed the
   * price, and both are saved atomically or not at all.
   */
  @IsOptional()
  @IsNumberString({}, { message: 'initialPayment must be a decimal string' })
  initialPayment?: string;
  @IsOptional() @IsNumberString() initialPaymentMethodId?: string;
  @IsOptional() @IsString() @Length(0, 100) initialPaymentReference?: string;
}

export class UpdatePurchaseDto {
  @IsOptional() @IsString() @Length(1, 200) productName?: string;
  @IsOptional() @IsNumberString() price?: string;
  @IsOptional() @IsDateString() purchaseDate?: string;
  @IsOptional() @IsString() notes?: string;
}

export class CreatePurchasePaymentDto {
  @IsNumberString({}, { message: 'amount must be a decimal string' })
  amount!: string;
  @IsDateString() paymentDate!: string;
  /** Must be a `supplier`-scoped method (BR-62). */
  @IsNumberString() paymentMethodId!: string;
  /** BR-29 — mandatory for LC, cheque, TT and bank; cash needs none. */
  @IsOptional() @IsString() @Length(0, 100) referenceNumber?: string;
  @IsOptional() @IsString() notes?: string;
}

export class UpdatePurchasePaymentDto {
  @IsOptional() @IsNumberString() amount?: string;
  @IsOptional() @IsDateString() paymentDate?: string;
  @IsOptional() @IsString() @Length(0, 100) referenceNumber?: string;
  @IsOptional() @IsString() notes?: string;
}

/** FR-05.5 / BR-31 — pay at the supplier level, oldest purchase first. */
export class SupplierPaymentDto {
  @IsNumberString({}, { message: 'amount must be a decimal string' })
  amount!: string;
  @IsDateString() paymentDate!: string;
  @IsNumberString() paymentMethodId!: string;
  @IsOptional() @IsString() @Length(0, 100) referenceNumber?: string;
  @IsOptional() @IsString() notes?: string;
}
