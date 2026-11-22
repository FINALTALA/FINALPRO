import {
  Controller,
  Get,
  HttpCode,
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
import { SalesRankQueryDto } from './dto/sales-rank-query.dto';
import { SalesRankService } from './sales-rank.service';

// PD-5.2: the internal sales rank - PLATFORM_ADMIN only (exact units and
// customer counts never leave this surface). A store owner's own view
// and anything public are PD-5.3.
@Controller('admin/sales-rank')
@UseGuards(SessionAuthGuard, PlatformRoleGuard)
export class AdminSalesRankController {
  constructor(private readonly salesRank: SalesRankService) {}

  @Get()
  @RequirePlatformRole(PlatformRole.PLATFORM_ADMIN)
  view(@Query() q: SalesRankQueryDto) {
    return this.salesRank.adminView({
      scope: q.scope,
      categoryCode: q.category,
      audience: q.audience,
      qualified: q.qualified === undefined ? undefined : q.qualified === 'true',
      take: q.take ?? 100,
    });
  }

  @Post('recompute')
  @HttpCode(200)
  @RequirePlatformRole(PlatformRole.PLATFORM_ADMIN)
  @UseInterceptors(IdempotencyInterceptor)
  recompute(@CurrentUser() user: AuthenticatedUser, @Req() req: Request) {
    return this.salesRank.rebuild({
      trigger: 'ADMIN',
      actorId: user.id,
      correlationId: req.correlationId,
    });
  }
}
