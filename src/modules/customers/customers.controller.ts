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
  CreateCustomerDto,
  ListCustomersQuery,
  UpdateCustomerDto,
} from './dto';
import { CustomersService, type CustomerRow } from './customers.service';

/** FR-03 — customers. */
@Controller('customers')
export class CustomersController {
  constructor(private readonly customers: CustomersService) {}

  @Get()
  @RequirePermission('view_customer')
  list(@Query() query: ListCustomersQuery): Promise<Page<CustomerRow>> {
    return this.customers.list(query);
  }

  /** The customer picker for a sale, confined to one shop (BR-53, FR-02.2.1). */
  @Get('options')
  @RequirePermission('view_customer')
  options(
    @Query('shopId') shopId: string,
  ): Promise<Array<{ id: string; label: string }>> {
    return this.customers.options(shopId);
  }

  @Get(':id')
  @RequirePermission('view_customer')
  findOne(@Param('id') id: string): Promise<CustomerRow> {
    return this.customers.findOne(id);
  }

  /**
   * FR-03.6.1 — the confirmation screen. Call this before offering Delete: it
   * counts the sales and payment records that will be destroyed with the
   * customer (BR-21), so the user acknowledges the loss rather than discovering
   * it.
   */
  @Get(':id/deletion-impact')
  @RequirePermission('delete_customer')
  deletionImpact(@Param('id') id: string) {
    return this.customers.deletionImpact(id);
  }

  @Post()
  @RequirePermission('add_customer')
  create(
    @Body() dto: CreateCustomerDto,
    @CurrentUser() actor: AuthUser,
  ): Promise<CustomerRow> {
    return this.customers.create(dto, actor.id);
  }

  @Patch(':id')
  @RequirePermission('change_customer')
  update(
    @Param('id') id: string,
    @Body() dto: UpdateCustomerDto,
    @CurrentUser() actor: AuthUser,
  ): Promise<CustomerRow> {
    return this.customers.update(id, dto, actor.id);
  }

  /**
   * BR-21 — this cascades to every sale, line item, payment, batch and
   * allocation belonging to the customer. Irreversible; see `deletion-impact`.
   */
  @Delete(':id')
  @HttpCode(204)
  @RequirePermission('delete_customer')
  remove(@Param('id') id: string): Promise<void> {
    return this.customers.remove(id);
  }
}
