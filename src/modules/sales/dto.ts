import { Type } from 'class-transformer';
import {
  ArrayMinSize,
  IsArray,
  IsDateString,
  IsIn,
  IsInt,
  IsNumberString,
  IsOptional,
  IsString,
  Min,
  ValidateNested,
} from 'class-validator';

/**
 * One line on a sale.
 *
 * BR-04 — a stocked line must reference an inventory item; a machine line must
 * carry a description. Neither may be saved without it. The shape is validated
 * here for a readable message, and `saleitem_kind_consistent` in the database
 * makes the bad state unrepresentable whatever this code does.
 */
export class SaleItemDto {
  @IsIn(['inventory', 'non_inventory']) itemType!:
    'inventory' | 'non_inventory';

  /** Required when `itemType` is `inventory`. */
  @IsOptional() @IsNumberString() inventoryItemId?: string;

  /** Required when `itemType` is `non_inventory` — this *is* the machine. */
  @IsOptional() @IsString() description?: string;

  @IsNumberString({}, { message: 'quantity must be a decimal string' })
  quantity!: string;

  @IsOptional() @Type(() => Number) @IsInt() @Min(0) boxes?: number;

  /**
   * Optional on a stocked line: left out or zero, the product's current selling
   * price is used. A positive entered price always wins (FR-02.2).
   */
  @IsOptional() @IsNumberString() unitPrice?: string;
}

/** An optional first payment, captured on the same form (FR-02.2). */
export class InitialPaymentDto {
  @IsNumberString({}, { message: 'amount must be a decimal string' })
  amount!: string;
  @IsDateString() paymentDate!: string;
  @IsNumberString() paymentMethodId!: string;
  @IsOptional() @IsString() notes?: string;
}

export class CreateSaleDto {
  @IsNumberString() customerId!: string;

  /** FR-02.2.1 — the sale is created against a shop (BR-49). */
  @IsNumberString() shopId!: string;

  /** BR-05 — a sale must have at least one valid line item. */
  @IsArray()
  @ArrayMinSize(1, {
    message: 'A sale must have at least one line item.',
  })
  @ValidateNested({ each: true })
  @Type(() => SaleItemDto)
  items!: SaleItemDto[];

  /**
   * FR-02.2 — quotation mode produces the same document as an offer. A sale
   * starts as `draft` unless this says otherwise; `finalized` is not accepted
   * here, because finalising is its own act with its own permission (FR-02.4.3).
   */
  @IsOptional() @IsIn(['draft', 'quote']) status?: 'draft' | 'quote';

  @IsOptional() @IsString() notes?: string;

  @IsOptional()
  @ValidateNested()
  @Type(() => InitialPaymentDto)
  initialPayment?: InitialPaymentDto;
}

export class UpdateSaleDto {
  @IsOptional() @IsString() notes?: string;
  /** Only a state the workflow allows; see SalesService.setStatus. */
  @IsOptional() @IsIn(['draft', 'quote', 'cancelled']) status?: string;
}

export class ListSalesQuery {
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) page?: number;
  /** FR-02.8 — sale number, customer name or customer ID. */
  @IsOptional() @IsString() search?: string;
  @IsOptional()
  @IsIn(['quote', 'draft', 'finalized', 'cancelled'])
  status?: string;
  @IsOptional() @IsNumberString() shopId?: string;
  @IsOptional() @IsNumberString() customerId?: string;
  @IsOptional() @IsDateString() createdFrom?: string;
  @IsOptional() @IsDateString() createdTo?: string;

  /** FR-02.8 — stocked products vs machines. Totals are apportioned (BR-15). */
  @IsOptional() @IsIn(['inventory', 'non_inventory']) itemType?: string;

  /**
   * FR-00.5 — managers get a "created by" filter to review one salesperson.
   * Using it as a non-manager must not widen visibility (BR-01), so it narrows
   * within the caller's own scope rather than replacing it.
   */
  @IsOptional() @IsNumberString() createdById?: string;
}

export class CreateSalePaymentDto {
  @IsNumberString({}, { message: 'amount must be a decimal string' })
  amount!: string;
  @IsDateString() paymentDate!: string;
  /** Must be a `customer`-scoped method (BR-62). */
  @IsNumberString() paymentMethodId!: string;
  @IsOptional() @IsString() notes?: string;
}

export class UpdateSalePaymentDto {
  @IsOptional() @IsNumberString() amount?: string;
  @IsOptional() @IsDateString() paymentDate?: string;
  /** Must be a `customer`-scoped method, same as on insert (BR-62). */
  @IsOptional() @IsNumberString() paymentMethodId?: string;
  @IsOptional() @IsString() notes?: string;
}

/** FR-03.5 — one lump sum from a customer, spread across their open invoices. */
export class CustomerPaymentDto {
  @IsNumberString({}, { message: 'amount must be a decimal string' })
  amount!: string;
  @IsDateString() paymentDate!: string;
  @IsNumberString() paymentMethodId!: string;
  @IsOptional() @IsString() notes?: string;
}

export class AddSaleItemDto extends SaleItemDto {}

/**
 * BR-67..BR-69 — the sale-level discount.
 *
 * A fixed amount only; no percentage is accepted or stored. `amount: "0"`
 * removes an existing discount, which is why there is no separate delete route.
 * Sent as a decimal string like every other money field (NFR-01).
 */
export class SaleDiscountDto {
  @IsNumberString({}, { message: 'amount must be a decimal string' })
  amount!: string;

  @IsOptional()
  @IsString()
  reason?: string;
}
