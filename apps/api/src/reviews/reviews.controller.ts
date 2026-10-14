import {
  Body,
  Controller,
  NotFoundException,
  Param,
  Post,
  Req,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { Request } from 'express';
import { CurrentUser } from '../auth/current-user.decorator';
import {
  AuthenticatedUser,
  SessionAuthGuard,
} from '../auth/session-auth.guard';
import { IdempotencyInterceptor } from '../common/idempotency/idempotency.interceptor';
import { PrismaService } from '../prisma/prisma.service';
import { CreateReviewDto } from './dto/create-review.dto';
import { ReportReviewDto } from './dto/report-review.dto';
import { ReviewsService } from './reviews.service';

@Controller('reviews')
@UseGuards(SessionAuthGuard)
export class ReviewsController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly reviews: ReviewsService,
  ) {}

  private async requireCustomerId(user: AuthenticatedUser): Promise<string> {
    const profile = await this.prisma.customerProfile.findUnique({
      where: { userId: user.id },
    });
    if (!profile) {
      throw new NotFoundException({
        code: 'CUSTOMER_PROFILE_NOT_FOUND',
        message: 'Customer profile not found',
      });
    }
    return profile.id;
  }

  @Post()
  @UseInterceptors(IdempotencyInterceptor)
  async submit(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: CreateReviewDto,
    @Req() req: Request,
  ) {
    const customerId = await this.requireCustomerId(user);
    return this.reviews.submit(
      customerId,
      user.id,
      {
        source_branch_order_item_id: dto.source_branch_order_item_id,
        target_type: dto.target_type,
        rating: dto.rating,
        body: dto.body,
      },
      req.correlationId,
    );
  }

  @Post(':id/report')
  @UseInterceptors(IdempotencyInterceptor)
  async report(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Body() dto: ReportReviewDto,
    @Req() req: Request,
  ) {
    const customerId = await this.requireCustomerId(user);
    return this.reviews.report(
      customerId,
      user.id,
      id,
      dto.reason,
      req.correlationId,
    );
  }
}
