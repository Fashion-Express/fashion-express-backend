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
import { Type } from 'class-transformer';
import { IsInt, IsOptional, Min } from 'class-validator';
import type { AuthUser } from '../auth/auth-user';
import { CurrentUser, RequirePermission } from '../auth/decorators';
import {
  CreateInventoryItemDto,
  ListInventoryQuery,
  UpdateInventoryItemDto,
} from './dto';
import { InventoryService, type InventoryRow } from './inventory.service';

class PageQuery {
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) page?: number;
}

/** FR-04 — inventory. */
@Controller('inventory')
export class InventoryController {
  constructor(private readonly inventory: InventoryService) {}

  /**
   * The list, and the summary bar above it.
   *
   * FR-04.4 — the summary reports for the current *filter*, not the current
   * page, so it is returned alongside rather than derived from `items`.
   */
  @Get()
  @RequirePermission('view_inventoryitem')
  list(@Query() query: ListInventoryQuery): Promise<Record<string, unknown>> {
    return this.inventory.list(query) as unknown as Promise<
      Record<string, unknown>
    >;
  }

  /** The line-item picker for a sale, confined to one shop (BR-50). */
  @Get('options')
  @RequirePermission('view_inventoryitem')
  options(
    @Query('shopId') shopId: string,
  ): Promise<Array<Record<string, unknown>>> {
    return this.inventory.options(shopId);
  }

  /** FR-01.5, FR-01.6 — the low-stock feed behind the banner on every page. */
  @Get('low-stock')
  @RequirePermission('view_inventoryitem')
  lowStock(
    @Query('shopId') shopId?: string,
    @Query('limit') limit?: string,
  ): Promise<Array<Record<string, unknown>>> {
    return this.inventory.lowStock(shopId, limit ? Number(limit) : 5);
  }

  @Get(':id')
  @RequirePermission('view_inventoryitem')
  findOne(@Param('id') id: string): Promise<InventoryRow> {
    return this.inventory.findOne(id);
  }

  /**
   * FR-04.5 — the movement history. Read-only by BR-25: movements are written
   * only by the system and are never edited or deleted, so there is no POST,
   * PATCH or DELETE here and there never should be.
   */
  @Get(':id/movements')
  @RequirePermission('view_inventoryitem')
  movements(@Param('id') id: string, @Query() query: PageQuery) {
    return this.inventory.movements(id, query.page ?? 1);
  }

  @Post()
  @RequirePermission('add_inventoryitem')
  create(
    @Body() dto: CreateInventoryItemDto,
    @CurrentUser() actor: AuthUser,
  ): Promise<InventoryRow> {
    return this.inventory.create(dto, actor.id);
  }

  @Patch(':id')
  @RequirePermission('change_inventoryitem')
  update(
    @Param('id') id: string,
    @Body() dto: UpdateInventoryItemDto,
    @CurrentUser() actor: AuthUser,
  ): Promise<InventoryRow> {
    return this.inventory.update(id, dto, actor.id);
  }

  @Delete(':id')
  @HttpCode(204)
  @RequirePermission('delete_inventoryitem')
  remove(@Param('id') id: string): Promise<void> {
    return this.inventory.remove(id);
  }
}
