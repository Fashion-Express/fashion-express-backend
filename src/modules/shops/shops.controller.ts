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
import { CreateShopDto, ListShopsQuery, UpdateShopDto } from './dto';
import { ShopsService, type ShopRow } from './shops.service';

/**
 * FR-11 — shops.
 *
 * A shop is a *scope* for other records rather than a record with substance of
 * its own, so this module is thin. What matters is BR-48: a shop that has ever
 * traded cannot be deleted, and deactivating is the supported retirement.
 */
@Controller('shops')
export class ShopsController {
  constructor(private readonly shops: ShopsService) {}

  @Get()
  @RequirePermission('view_shop')
  list(@Query() query: ListShopsQuery): Promise<Page<ShopRow>> {
    return this.shops.list(query);
  }

  /**
   * Active shops, for the shop picker on every create form.
   *
   * Needs no `view_shop`: anyone creating a customer or a product has to choose
   * a shop (BR-49), so gating this would make the day-to-day screens unusable.
   */
  @Get('options')
  options(): Promise<Array<{ id: string; name: string }>> {
    return this.shops.options();
  }

  @Get(':id')
  @RequirePermission('view_shop')
  findOne(@Param('id') id: string): Promise<ShopRow> {
    return this.shops.findOne(id);
  }

  @Post()
  @RequirePermission('add_shop')
  create(
    @Body() dto: CreateShopDto,
    @CurrentUser() actor: AuthUser,
  ): Promise<ShopRow> {
    return this.shops.create(dto, actor.id);
  }

  @Patch(':id')
  @RequirePermission('change_shop')
  update(
    @Param('id') id: string,
    @Body() dto: UpdateShopDto,
    @CurrentUser() actor: AuthUser,
  ): Promise<ShopRow> {
    return this.shops.update(id, dto, actor.id);
  }

  @Delete(':id')
  @HttpCode(204)
  @RequirePermission('delete_shop')
  remove(@Param('id') id: string): Promise<void> {
    return this.shops.remove(id);
  }
}
