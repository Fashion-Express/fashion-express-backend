import { Body, Controller, Get, Patch, Post } from '@nestjs/common';
import type { AuthUser } from '../auth/auth-user';
import {
  CurrentUser,
  RequireManager,
  RequirePermission,
  RequireSuperuser,
} from '../auth/decorators';
import {
  AdminService,
  CLEANUP_PHRASE,
  INCLUDE_ADMINS_PHRASE,
} from './admin.service';
import { CleanDataDto, UpdateBusinessSettingsDto } from './dto';

/** FR-10 — administration. */
@Controller('admin')
export class AdminController {
  constructor(private readonly admin: AdminService) {}

  /**
   * FR-10.1 — the business details.
   *
   * **Readable by any signed-in user**, because every printed invoice and
   * receipt needs them and the client renders the letterhead. Only a manager
   * may change them.
   */
  @Get('business-settings')
  settings() {
    return this.admin.settings();
  }

  @Patch('business-settings')
  @RequireManager()
  @RequirePermission('change_businesssettings')
  updateSettings(
    @Body() dto: UpdateBusinessSettingsDto,
    @CurrentUser() actor: AuthUser,
  ) {
    return this.admin.updateSettings(dto, actor.id);
  }

  /** FR-10.2 — the four role groups and the baseline permissions each carries. */
  @Get('roles')
  @RequireManager()
  @RequirePermission('view_user')
  roles() {
    return this.admin.roles();
  }

  /** What the cleanup tool can clear, and the phrases it will demand. */
  @Get('cleanup')
  @RequireSuperuser()
  @RequirePermission('clean_data')
  cleanupInfo() {
    return {
      enabled: process.env.ENABLE_DATA_CLEANUP === 'true',
      targets: this.admin.cleanableTargets(),
      confirmationPhrase: CLEANUP_PHRASE,
      includeAdminsPhrase: INCLUDE_ADMINS_PHRASE,
      safeguards: [
        'Restricted to administrators.',
        'Off unless ENABLE_DATA_CLEANUP=true.',
        'Requires an exact confirmation phrase; without it this previews.',
        'Administrator accounts and your own account are preserved ' +
          'unless the second, different phrase is given.',
      ],
    };
  }

  /**
   * FR-10.3 — clear selected data.
   *
   * **Without `confirmation` this previews and writes nothing** (BR-43). The
   * four safeguards are independent and all four apply: the decorators here
   * cover BR-41, and the service re-checks it alongside BR-42, BR-43 and BR-44
   * — the one operation where a missed guard cannot be undone.
   */
  @Post('cleanup')
  @RequireSuperuser()
  @RequirePermission('clean_data')
  clean(@Body() dto: CleanDataDto, @CurrentUser() user: AuthUser) {
    return this.admin.cleanData(
      dto.targets,
      user,
      dto.confirmation,
      dto.includeAdminsConfirmation,
    );
  }
}
