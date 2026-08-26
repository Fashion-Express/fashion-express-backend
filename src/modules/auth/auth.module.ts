import { Global, Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { AuthController } from './auth.controller';
import { AuthGuard } from './auth.guard';
import { PermissionsService } from './permissions.service';
import { SessionService } from './session.service';

/**
 * FR-00.1 — `AuthGuard` is registered with `APP_GUARD`, so it runs on every
 * route in the application and access is closed by default. A route opens only
 * by saying `@Public()`.
 *
 * Global, because `SessionService` and `PermissionsService` are needed by any
 * module that resolves a user, and threading imports for them through every
 * feature module would be noise.
 */
@Global()
@Module({
  controllers: [AuthController],
  providers: [
    SessionService,
    PermissionsService,
    { provide: APP_GUARD, useClass: AuthGuard },
  ],
  exports: [SessionService, PermissionsService],
})
export class AuthModule {}
