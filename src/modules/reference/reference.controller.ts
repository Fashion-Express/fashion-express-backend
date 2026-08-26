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
  CreateReferenceDto,
  ListReferenceQuery,
  UpdateReferenceDto,
} from './dto';
import { ReferenceService, type ReferenceRow } from './reference.service';

/**
 * FR-12.5 — the administration screens for the twelve reference lists.
 *
 * **Reads are open to any signed-in user; writes need `manage_referencedata`.**
 * That split matters: managing these lists is an administrative act (FR-12.5.1),
 * but *reading* them is not — a salesperson creating a product needs the units
 * picker, and a permission wall there would make the day-to-day screens
 * unusable.
 */
@Controller('reference')
export class ReferenceController {
  constructor(private readonly reference: ReferenceService) {}

  /**
   * The catalogue of lists, each with the operations it permits.
   *
   * FR-12.5.2 asks for the structural lists to present no "add" action and no
   * delete. Rather than have the client hard-code which three those are, each
   * entry reports its own capabilities.
   */
  @Get()
  catalogue(): Array<Record<string, unknown>> {
    return this.reference.catalogue();
  }

  @Get(':list')
  list(
    @Param('list') slug: string,
    @Query() query: ListReferenceQuery,
  ): Promise<Page<ReferenceRow>> {
    return this.reference.list(slug, query);
  }

  /** Active entries only — the feed a dropdown should use (§23.6). */
  @Get(':list/options')
  options(
    @Param('list') slug: string,
    @Query('scope') scope?: string,
  ): Promise<ReferenceRow[]> {
    return this.reference.options(slug, scope);
  }

  @Get(':list/:id')
  findOne(
    @Param('list') slug: string,
    @Param('id') id: string,
  ): Promise<ReferenceRow> {
    return this.reference.findOne(slug, id);
  }

  /** What would break if this entry were retired (BR-60). */
  @Get(':list/:id/usage')
  usage(
    @Param('list') slug: string,
    @Param('id') id: string,
  ): Promise<{ total: number; byTable: Record<string, number> }> {
    return this.reference.usage(slug, id);
  }

  @Post(':list')
  @RequirePermission('manage_referencedata')
  create(
    @Param('list') slug: string,
    @Body() dto: CreateReferenceDto,
    @CurrentUser() actor: AuthUser,
  ): Promise<ReferenceRow> {
    return this.reference.create(slug, dto, actor.id);
  }

  /** Editing a code is impossible by construction: the DTO has no such field (BR-59). */
  @Patch(':list/:id')
  @RequirePermission('manage_referencedata')
  update(
    @Param('list') slug: string,
    @Param('id') id: string,
    @Body() dto: UpdateReferenceDto,
    @CurrentUser() actor: AuthUser,
  ): Promise<ReferenceRow> {
    return this.reference.update(slug, id, dto, actor.id);
  }

  @Delete(':list/:id')
  @HttpCode(204)
  @RequirePermission('manage_referencedata')
  remove(@Param('list') slug: string, @Param('id') id: string): Promise<void> {
    return this.reference.remove(slug, id);
  }
}
