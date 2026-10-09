import {
  Body,
  Controller,
  Param,
  Patch,
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
import { ReturnDecisionDto } from '../returns/dto/return-decision.dto';
import { ReturnsService } from '../returns/returns.service';

// Sprint 21 (EPIC-RET): the Return state machine's own ESCALATED
// resolution - PLATFORM_ADMIN only, same "break-glass" authorization
// shape as AdminBranchOrdersController's forced-cancel (no separate
// support-agent role exists in this codebase).
@Controller('admin/returns')
@UseGuards(SessionAuthGuard, PlatformRoleGuard)
export class AdminReturnsController {
  constructor(private readonly returns: ReturnsService) {}

  @Patch(':returnId/escalation-decision')
  @RequirePlatformRole(PlatformRole.PLATFORM_ADMIN)
  @UseInterceptors(IdempotencyInterceptor)
  async decide(
    @Param('returnId') returnId: string,
    @Body() dto: ReturnDecisionDto,
    @CurrentUser() user: AuthenticatedUser,
    @Req() req: Request,
  ) {
    return this.returns.resolveEscalation(
      user.id,
      req.correlationId,
      returnId,
      dto,
    );
  }
}
