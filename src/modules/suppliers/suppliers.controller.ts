import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import type { Page } from '../../common/pagination';
import type { AuthUser } from '../auth/auth-user';
import { CurrentUser, RequirePermission } from '../auth/decorators';
import {
  CreatePurchaseDto,
  CreatePurchasePaymentDto,
  CreateSupplierDto,
  ListSuppliersQuery,
  SupplierPaymentDto,
  UpdatePurchaseDto,
  UpdatePurchasePaymentDto,
  UpdateSupplierDto,
} from './dto';
import { SuppliersService, type SupplierRow } from './suppliers.service';

/**
 * FR-05 — suppliers, purchases and payments.
 *
 * Not shop-scoped: buying is done centrally for the business (FR-11.4).
 */
@Controller()
export class SuppliersController {
  constructor(private readonly suppliers: SuppliersService) {}

  // ---- suppliers -----------------------------------------------------

  @Get('suppliers')
  @RequirePermission('view_supplier')
  list(@Query() query: ListSuppliersQuery): Promise<Page<SupplierRow>> {
    return this.suppliers.list(query);
  }

  /** Picker for the inventory form's supplier reference (FR-04.1.1). */
  @Get('suppliers/options')
  options(): Promise<Array<{ id: string; name: string }>> {
    return this.suppliers.options();
  }

  @Get('suppliers/:id')
  @RequirePermission('view_supplier')
  findOne(@Param('id') id: string): Promise<SupplierRow> {
    return this.suppliers.findOne(id);
  }

  @Post('suppliers')
  @RequirePermission('add_supplier')
  create(
    @Body() dto: CreateSupplierDto,
    @CurrentUser() actor: AuthUser,
  ): Promise<SupplierRow> {
    return this.suppliers.create(dto, actor.id);
  }

  @Patch('suppliers/:id')
  @RequirePermission('change_supplier')
  update(
    @Param('id') id: string,
    @Body() dto: UpdateSupplierDto,
    @CurrentUser() actor: AuthUser,
  ): Promise<SupplierRow> {
    return this.suppliers.update(id, dto, actor.id);
  }

  @Delete('suppliers/:id')
  @HttpCode(204)
  @RequirePermission('delete_supplier')
  remove(@Param('id') id: string): Promise<void> {
    return this.suppliers.remove(id);
  }

  // ---- purchases -----------------------------------------------------

  @Get('suppliers/:id/purchases')
  @RequirePermission('view_supplier')
  purchases(@Param('id') id: string): Promise<Array<Record<string, unknown>>> {
    return this.suppliers.purchases(id);
  }

  @Post('suppliers/:id/purchases')
  @RequirePermission('add_supplier')
  createPurchase(
    @Param('id') id: string,
    @Body() dto: CreatePurchaseDto,
    @CurrentUser() actor: AuthUser,
  ): Promise<Record<string, unknown>> {
    return this.suppliers.createPurchase(id, dto, actor.id);
  }

  /**
   * BR-31 — allocate one amount across the supplier's outstanding purchases,
   * oldest first. Each purchase touched receives its own payment row and its
   * own receipt number.
   */
  @Post('suppliers/:id/pay')
  @RequirePermission('add_supplierpayment')
  paySupplier(
    @Param('id') id: string,
    @Body() dto: SupplierPaymentDto,
    @CurrentUser() actor: AuthUser,
  ): Promise<{ allocated: Array<{ purchaseId: string; amount: string }> }> {
    return this.suppliers.paySupplier(id, dto, actor.id);
  }

  @Get('purchases/:id')
  @RequirePermission('view_supplier')
  findPurchase(@Param('id') id: string): Promise<Record<string, unknown>> {
    return this.suppliers.findPurchase(id);
  }

  @Patch('purchases/:id')
  @RequirePermission('change_supplier')
  updatePurchase(
    @Param('id') id: string,
    @Body() dto: UpdatePurchaseDto,
    @CurrentUser() actor: AuthUser,
  ): Promise<Record<string, unknown>> {
    return this.suppliers.updatePurchase(id, dto, actor.id);
  }

  @Delete('purchases/:id')
  @HttpCode(204)
  @RequirePermission('delete_supplier')
  removePurchase(@Param('id') id: string): Promise<void> {
    return this.suppliers.removePurchase(id);
  }

  // ---- payments ------------------------------------------------------

  @Get('purchases/:id/payments')
  @RequirePermission('view_supplier')
  payments(@Param('id') id: string): Promise<Array<Record<string, unknown>>> {
    return this.suppliers.payments(id);
  }

  @Post('purchases/:id/payments')
  @RequirePermission('add_supplierpayment')
  addPayment(
    @Param('id') id: string,
    @Body() dto: CreatePurchasePaymentDto,
    @CurrentUser() actor: AuthUser,
  ): Promise<Record<string, unknown>> {
    return this.suppliers.addPayment(id, dto, actor.id);
  }

  @Patch('purchase-payments/:id')
  @RequirePermission('add_supplierpayment')
  updatePayment(
    @Param('id') id: string,
    @Body() dto: UpdatePurchasePaymentDto,
    @CurrentUser() actor: AuthUser,
  ): Promise<Record<string, unknown>> {
    return this.suppliers.updatePayment(id, dto, actor.id);
  }

  @Delete('purchase-payments/:id')
  @HttpCode(204)
  @RequirePermission('add_supplierpayment')
  removePayment(@Param('id') id: string): Promise<void> {
    return this.suppliers.removePayment(id);
  }
}
