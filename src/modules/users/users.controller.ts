import {
  Body,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import type { Page } from '../../common/pagination';
import type { AuthUser } from '../auth/auth-user';
import {
  CurrentUser,
  RequirePermission,
  RequireSuperuser,
} from '../auth/decorators';
import {
  CreateUserDto,
  ListUsersQuery,
  SetPasswordDto,
  UpdateUserDto,
} from './dto';
import { UsersService, type StaffRow } from './users.service';

/**
 * FR-00.6 — staff accounts.
 *
 * Every route carries the permission that gates it, which is the whole point of
 * §10.3 option B: there is one place to look to find out why someone can do
 * something. `AuthGuard` enforces these; the client hides the buttons (FR-00.3)
 * but that is presentation, not protection.
 */
@Controller('users')
export class UsersController {
  constructor(private readonly users: UsersService) {}

  @Get()
  @RequirePermission('view_user')
  list(@Query() query: ListUsersQuery): Promise<Page<StaffRow>> {
    return this.users.list(query);
  }

  /** FR-12.1 — the four user types, for the create and edit forms. */
  @Get('types')
  @RequirePermission('view_user')
  types(): Promise<Array<{ id: string; code: string; label: string }>> {
    return this.users.userTypes();
  }

  @Get('types/:id/permissions')
  @RequirePermission('manage_referencedata')
  grants(@Param('id') id: string) {
    return this.users.grantsFor(id);
  }

  /** Active staff for a picker. Before `:id`, or 'options' matches as an id. */
  @Get('options')
  @RequirePermission('view_user')
  options(): Promise<Array<{ id: string; name: string }>> {
    return this.users.options();
  }

  @Get(':id')
  @RequirePermission('view_user')
  findOne(@Param('id') id: string): Promise<StaffRow> {
    return this.users.findOne(id);
  }

  @Post()
  @RequirePermission('add_user')
  create(
    @Body() dto: CreateUserDto,
    @CurrentUser() actor: AuthUser,
  ): Promise<StaffRow> {
    return this.users.create(dto, actor.id);
  }

  @Patch(':id')
  @RequirePermission('change_user')
  update(
    @Param('id') id: string,
    @Body() dto: UpdateUserDto,
    @CurrentUser() actor: AuthUser,
  ): Promise<StaffRow> {
    return this.users.update(id, dto, actor.id);
  }

  /**
   * Set someone's password.
   *
   * A staff member may always change their own; changing anyone else's needs
   * `change_user`. The self case is checked here rather than by a decorator
   * because it depends on the *value* of a route parameter, which metadata
   * cannot see.
   */
  @Post(':id/password')
  @HttpCode(204)
  async setPassword(
    @Param('id') id: string,
    @Body() dto: SetPasswordDto,
    @CurrentUser() actor: AuthUser,
  ): Promise<void> {
    const isSelf = id === actor.id;
    const mayChangeOthers =
      actor.isSuperuser || actor.permissions.has('change_user');

    if (!isSelf && !mayChangeOthers) {
      throw new ForbiddenException('You may only change your own password.');
    }
    await this.users.setPassword(id, dto.password);
  }

  /**
   * Deletion is restricted to unrestricted accounts, and is rarely the right
   * action — see the note on `UsersService.remove`. Deactivate instead.
   */
  @Delete(':id')
  @HttpCode(204)
  @RequireSuperuser()
  @RequirePermission('delete_user')
  async remove(
    @Param('id') id: string,
    @CurrentUser() actor: AuthUser,
  ): Promise<void> {
    await this.users.remove(id, actor.id);
  }
}
