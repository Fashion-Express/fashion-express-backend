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
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { TransactionService } from '../../common/transaction';
import { firstRow } from '../../common/sql';
import type { AuthUser } from '../auth/auth-user';
import { CurrentUser, RequirePermission } from '../auth/decorators';
import { CustomerPaymentsService } from './customer-payments.service';
import {
  AddSaleItemDto,
  CreateSaleDto,
  CreateSalePaymentDto,
  CustomerPaymentDto,
  ListSalesQuery,
  UpdateSaleDto,
  UpdateSalePaymentDto,
} from './dto';
import { FinalisationService } from './finalisation.service';
import { SalePaymentsService } from './sale-payments.service';
import { SalesService, type SaleRow } from './sales.service';

/**
 * FR-02 — sales, and FR-03.4/FR-03.5's customer account and lump-sum payment.
 *
 * **BR-01 runs through every read here.** A user who is not a manager or
 * superuser sees only the sales they created — in the list, on the detail page,
 * in the line items and in the payment history. That is applied in the query
 * layer by `SalesService`, not by a guard, because a guard cannot express
 * "only the rows you created".
 */
@Controller()
export class SalesController {
  constructor(
    private readonly sales: SalesService,
    private readonly payments: SalePaymentsService,
    private readonly finalisation: FinalisationService,
    private readonly customerPayments: CustomerPaymentsService,
    private readonly transactions: TransactionService,
    @InjectDataSource() private readonly dataSource: DataSource,
  ) {}

  // ---- sales ---------------------------------------------------------

  @Get('sales')
  @RequirePermission('view_sale')
  list(@Query() query: ListSalesQuery, @CurrentUser() user: AuthUser) {
    return this.sales.list(query, user);
  }

  @Get('sales/:id')
  @RequirePermission('view_sale')
  findOne(
    @Param('id') id: string,
    @CurrentUser() user: AuthUser,
  ): Promise<SaleRow> {
    return this.sales.findOne(id, user);
  }

  @Get('sales/:id/items')
  @RequirePermission('view_sale')
  items(@Param('id') id: string, @CurrentUser() user: AuthUser) {
    return this.sales.items(id, user);
  }

  @Get('sales/:id/payments')
  @RequirePermission('view_sale')
  async payments_(@Param('id') id: string, @CurrentUser() user: AuthUser) {
    // Through findOne so BR-01 scopes the payment history too.
    await this.sales.assertVisible(id, user);
    return this.payments.forSale(id);
  }

  @Post('sales')
  @RequirePermission('add_sale')
  create(
    @Body() dto: CreateSaleDto,
    @CurrentUser() user: AuthUser,
  ): Promise<SaleRow> {
    return this.sales.create(dto, user);
  }

  @Patch('sales/:id')
  @RequirePermission('change_sale')
  update(
    @Param('id') id: string,
    @Body() dto: UpdateSaleDto,
    @CurrentUser() user: AuthUser,
  ): Promise<SaleRow> {
    return this.sales.update(id, dto, user);
  }

  /** FR-02.3.1 — a quotation becomes a draft invoice, keeping items and prices. */
  @Post('sales/:id/convert')
  @RequirePermission('change_sale')
  convert(
    @Param('id') id: string,
    @CurrentUser() user: AuthUser,
  ): Promise<SaleRow> {
    return this.sales.convertQuotation(id, user);
  }

  /**
   * FR-02.4 — finalising.
   *
   * FR-02.4.3 gives this its own permission, so the staff who assemble orders
   * need not be the staff who commit them.
   */
  @Post('sales/:id/finalize')
  @RequirePermission('finalize_sale')
  async finalize(@Param('id') id: string, @CurrentUser() user: AuthUser) {
    await this.sales.assertVisible(id, user);
    const result = await this.finalisation.finalise(id, user.id);
    return {
      ...result,
      sale: await this.sales.findOne(id, user),
    };
  }

  /** BR-14 — only draft sales may be deleted. */
  @Delete('sales/:id')
  @HttpCode(204)
  @RequirePermission('delete_sale')
  remove(
    @Param('id') id: string,
    @CurrentUser() user: AuthUser,
  ): Promise<void> {
    return this.sales.remove(id, user);
  }

  // ---- line items ----------------------------------------------------

  /**
   * FR-02.6.1 — adding a line to a finalised sale is restricted to
   * administrators, and BR-13 deducts the stock immediately.
   */
  @Post('sales/:id/items')
  @RequirePermission('change_sale')
  async addItem(
    @Param('id') id: string,
    @Body() dto: AddSaleItemDto,
    @CurrentUser() user: AuthUser,
  ) {
    const sale = await this.sales.assertVisible(id, user);
    if (sale.status_code === 'finalized')
      this.sales.assertMayEditFinalised(user);

    await this.transactions.run(async (manager) => {
      await this.sales.insertItem(manager, id, sale.shop_id, dto);

      if (sale.status_code === 'finalized') {
        const line = firstRow<{ id: string }>(
          await manager.query(
            `SELECT id::text FROM sale_items WHERE sale_id = $1
              ORDER BY id DESC LIMIT 1`,
            [id],
          ),
        )!;
        await this.finalisation.deductForAddedLine(
          manager,
          id,
          line.id,
          sale.sale_number,
          user.id,
        );
      }
    });

    return this.sales.findOne(id, user);
  }

  /**
   * FR-02.6.1 / BR-12 — removing a line from a finalised sale returns its stock
   * with a reversing movement. FR-02.6.2 — if that empties the sale it reverts
   * to draft and its payments are deleted; the response says how many.
   */
  @Delete('sales/:id/items/:itemId')
  @RequirePermission('change_sale')
  async removeItem(
    @Param('id') id: string,
    @Param('itemId') itemId: string,
    @CurrentUser() user: AuthUser,
  ) {
    const sale = await this.sales.assertVisible(id, user);
    if (sale.status_code === 'finalized')
      this.sales.assertMayEditFinalised(user);

    const result = await this.finalisation.reverseRemovedLine(
      id,
      itemId,
      user.id,
    );
    return { ...result, sale: await this.sales.findOne(id, user) };
  }

  // ---- payments ------------------------------------------------------

  @Post('sales/:id/payments')
  @RequirePermission('add_salepayment')
  async addPayment(
    @Param('id') id: string,
    @Body() dto: CreateSalePaymentDto,
    @CurrentUser() user: AuthUser,
  ) {
    await this.sales.assertVisible(id, user);
    const result = await this.payments.add(id, dto, user.id);
    return { ...result, sale: await this.sales.findOne(id, user) };
  }

  @Patch('sale-payments/:id')
  @RequirePermission('change_salepayment')
  async updatePayment(
    @Param('id') id: string,
    @Body() dto: UpdateSalePaymentDto,
    @CurrentUser() user: AuthUser,
  ) {
    await this.payments.update(id, dto, user.id);
    return { ok: true };
  }

  @Delete('sale-payments/:id')
  @HttpCode(204)
  @RequirePermission('delete_salepayment')
  removePayment(@Param('id') id: string): Promise<void> {
    return this.payments.remove(id);
  }

  // ---- customer account and lump-sum payment (FR-03.4, FR-03.5) ------

  @Get('customers/:id/account')
  @RequirePermission('view_customer')
  account(@Param('id') id: string) {
    return this.customerPayments.account(id);
  }

  /** FR-03.5.1 — the client offers the payment action only when this is > 0. */
  @Get('customers/:id/outstanding')
  @RequirePermission('view_customer')
  async outstanding(@Param('id') id: string) {
    return { outstanding: await this.customerPayments.outstanding(id) };
  }

  @Post('customers/:id/payments')
  @RequirePermission('add_customerpayment')
  allocate(
    @Param('id') id: string,
    @Body() dto: CustomerPaymentDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.customerPayments.allocate(id, dto, user.id);
  }

  /** BR-19 — the combined receipt for one payment event. */
  @Get('customer-payments/:batchRef')
  @RequirePermission('view_customer')
  batch(@Param('batchRef') batchRef: string) {
    return this.customerPayments.batch(batchRef);
  }
}
