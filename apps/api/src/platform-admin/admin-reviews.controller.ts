import {
  Body,
  Controller,
  Get,
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
import { ReviewDecisionDto } from '../reviews/dto/review-decision.dto';
import { ReviewsService } from '../reviews/reviews.service';

// Sprint 23 (PDR-032): the review-report queue's own resolution -
// PLATFORM_ADMIN only (final decision #6 - no new role).
@Controller('admin/reviews')
@UseGuards(SessionAuthGuard, PlatformRoleGuard)
export class AdminReviewsController {
  constructor(private readonly reviews: ReviewsService) {}

  @Get('reported')
  @RequirePlatformRole(PlatformRole.PLATFORM_ADMIN)
  async listReported() {
    return this.reviews.listReported();
  }

  @Patch(':reviewId/decision')
  @RequirePlatformRole(PlatformRole.PLATFORM_ADMIN)
  @UseInterceptors(IdempotencyInterceptor)
  async decide(
    @Param('reviewId') reviewId: string,
    @Body() dto: ReviewDecisionDto,
    @CurrentUser() user: AuthenticatedUser,
    @Req() req: Request,
  ) {
    return this.reviews.decide(
      user.id,
      reviewId,
      dto.decision,
      req.correlationId,
    );
  }
}
