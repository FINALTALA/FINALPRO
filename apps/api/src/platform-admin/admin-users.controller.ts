import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  Post,
  Query,
  Req,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { Request } from 'express';
import { PlatformRole } from '../../generated/prisma/client';
import { CurrentUser } from '../auth/current-user.decorator';
import { RequirePlatformRole } from '../auth/platform-role.decorator';
import { PlatformRoleGuard } from '../auth/platform-role.guard';
import {
  AuthenticatedUser,
  SessionAuthGuard,
} from '../auth/session-auth.guard';
import { IdempotencyInterceptor } from '../common/idempotency/idempotency.interceptor';
import {
  ForceSignOutDto,
  LiftSuspensionDto,
  SuspendUserDto,
} from './admin-users.dto';
import { AdminUsersService } from './admin-users.service';

/** VIA phase 3 - Users Management and the platform team (PLATFORM_ADMIN only). */
@Controller('admin')
@UseGuards(SessionAuthGuard, PlatformRoleGuard)
export class AdminUsersController {
  constructor(private readonly users: AdminUsersService) {}

  @Get('users')
  @RequirePlatformRole(PlatformRole.PLATFORM_ADMIN)
  list(
    @Query('q') q?: string,
    @Query('role') role?: string,
    @Query('status') status?: string,
    @Query('cursor') cursor?: string,
    @Query('limit') limit?: string,
  ) {
    return this.users.list({ q, role, status, cursor, limit });
  }

  @Get('team')
  @RequirePlatformRole(PlatformRole.PLATFORM_ADMIN)
  team() {
    return this.users.team();
  }

  @Get('users/:userId')
  @RequirePlatformRole(PlatformRole.PLATFORM_ADMIN)
  detail(
    @Param('userId') userId: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.users.detail(userId, user.id);
  }

  @Post('users/:userId/suspend')
  @RequirePlatformRole(PlatformRole.PLATFORM_ADMIN)
  @UseInterceptors(IdempotencyInterceptor)
  @HttpCode(201)
  suspend(
    @Param('userId') userId: string,
    @Body() dto: SuspendUserDto,
    @CurrentUser() user: AuthenticatedUser,
    @Req() req: Request,
  ) {
    return this.users.suspend(user.id, userId, dto.reason, req.correlationId);
  }

  @Post('users/:userId/lift-suspension')
  @RequirePlatformRole(PlatformRole.PLATFORM_ADMIN)
  @UseInterceptors(IdempotencyInterceptor)
  @HttpCode(201)
  lift(
    @Param('userId') userId: string,
    @Body() dto: LiftSuspensionDto,
    @CurrentUser() user: AuthenticatedUser,
    @Req() req: Request,
  ) {
    return this.users.lift(user.id, userId, dto.note, req.correlationId);
  }

  @Post('users/:userId/force-sign-out')
  @RequirePlatformRole(PlatformRole.PLATFORM_ADMIN)
  @UseInterceptors(IdempotencyInterceptor)
  @HttpCode(201)
  forceSignOut(
    @Param('userId') userId: string,
    @Body() dto: ForceSignOutDto,
    @CurrentUser() user: AuthenticatedUser,
    @Req() req: Request,
  ) {
    return this.users.forceSignOut(
      user.id,
      userId,
      dto.reason,
      req.correlationId,
    );
  }
}
