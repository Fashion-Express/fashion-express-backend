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
import type { AuthUser } from '../auth/auth-user';
import {
  CurrentUser,
  RequireManager,
  RequirePermission,
} from '../auth/decorators';
import { CreateExpenseDto, ListExpensesQuery, UpdateExpenseDto } from './dto';
import { ExpensesService } from './expenses.service';

/**
 * FR-06 — expenses.
 *
 * **BR-33 is the rule that shapes this controller**: anyone holding the add
 * permission may create an expense, but **only managers may edit or delete
 * one**. That asymmetry is deliberate — recording a cost is day-to-day work,
 * changing one after the fact is not, because the ledger has already moved.
 */
@Controller('expenses')
export class ExpensesController {
  constructor(private readonly expenses: ExpensesService) {}

  @Get()
  @RequirePermission('view_expense')
  list(@Query() query: ListExpensesQuery) {
    return this.expenses.list(query);
  }

  /** FR-09.1 — expenses by category, ranked by size. */
  @Get('by-category')
  @RequirePermission('view_expense')
  byCategory(@Query('year') year?: string) {
    return this.expenses.byCategory(year);
  }

  @Get(':id')
  @RequirePermission('view_expense')
  findOne(@Param('id') id: string) {
    return this.expenses.findOne(id);
  }

  @Post()
  @RequirePermission('add_expense')
  create(@Body() dto: CreateExpenseDto, @CurrentUser() actor: AuthUser) {
    return this.expenses.create(dto, actor.id);
  }

  /** BR-33 — manager-only, on top of the permission. */
  @Patch(':id')
  @RequireManager()
  @RequirePermission('change_expense')
  update(
    @Param('id') id: string,
    @Body() dto: UpdateExpenseDto,
    @CurrentUser() actor: AuthUser,
  ) {
    return this.expenses.update(id, dto, actor.id);
  }

  @Delete(':id')
  @HttpCode(204)
  @RequireManager()
  @RequirePermission('delete_expense')
  remove(@Param('id') id: string): Promise<void> {
    return this.expenses.remove(id);
  }
}
