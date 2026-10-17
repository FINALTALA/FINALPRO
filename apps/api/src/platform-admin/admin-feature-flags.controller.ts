import {
  Body,
  Controller,
  Get,
  Param,
  Put,
  Req,
  UseGuards,
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
import { SetFeatureFlagDto } from '../feature-flags/dto/set-feature-flag.dto';
import { FeatureFlagsService } from '../feature-flags/feature-flags.service';

// Sprint 25 (FR-ADMIN-004): PLATFORM_ADMIN only - no VERIFICATION_REVIEWER
// access, same split every other admin-only (not reviewer-shared)
// controller in this codebase already uses. Deliberately no public or
// session-only GET anywhere in this file - a flag's state is never
// exposed outside the admin surface that manages it (see
// feature-flags.service.ts's own comment on why a protected page
// simply handles its own 404 FEATURE_DISABLED instead).
@Controller('admin/feature-flags')
@UseGuards(SessionAuthGuard, PlatformRoleGuard)
export class AdminFeatureFlagsController {
  constructor(private readonly featureFlags: FeatureFlagsService) {}

  @Get()
  @RequirePlatformRole(PlatformRole.PLATFORM_ADMIN)
  async list() {
    return this.featureFlags.list();
  }

  @Put(':key')
  @RequirePlatformRole(PlatformRole.PLATFORM_ADMIN)
  async setFlag(
    @Param('key') key: string,
    @Body() dto: SetFeatureFlagDto,
    @CurrentUser() user: AuthenticatedUser,
    @Req() req: Request,
  ) {
    return this.featureFlags.setFlag(
      key,
      dto.enabled,
      user.id,
      req.correlationId,
    );
  }
}
