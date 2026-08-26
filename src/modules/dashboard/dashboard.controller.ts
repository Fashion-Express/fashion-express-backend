import { Controller, Get, Query } from '@nestjs/common';
import type { AuthUser } from '../auth/auth-user';
import { CurrentUser } from '../auth/decorators';
import { DashboardService } from './dashboard.service';

/**
 * FR-01 — the dashboard.
 *
 * No permission decorator: what a caller sees is decided by *their* permissions
 * inside the service (FR-01.7), not by a gate on the route. A user with only
 * bill-claim rights gets a reduced view rather than a 403 — being told "no" on
 * the landing page after signing in successfully is a poor answer.
 */
@Controller()
export class DashboardController {
  constructor(private readonly dashboard: DashboardService) {}

  @Get('dashboard')
  build(@CurrentUser() user: AuthUser, @Query('shopId') shopId?: string) {
    return this.dashboard.build(user, shopId);
  }

  /** FR-01.6 — the count that must appear on every page of the application. */
  @Get('low-stock-count')
  banner(@Query('shopId') shopId?: string) {
    return this.dashboard.lowStockBanner(shopId);
  }
}
