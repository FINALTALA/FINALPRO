import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  NotFoundException,
  Param,
  Patch,
  Post,
  Req,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { Throttle } from '@nestjs/throttler';
import { Request } from 'express';
import { CurrentUser } from '../auth/current-user.decorator';
import {
  AuthenticatedUser,
  SessionAuthGuard,
} from '../auth/session-auth.guard';
import { IdempotencyInterceptor } from '../common/idempotency/idempotency.interceptor';
import { PrismaService } from '../prisma/prisma.service';
import { CreateReviewDto, UpdateReviewDto } from './dto/create-review.dto';
import { ReportReviewDto } from './dto/report-review.dto';
import { MAX_REVIEW_IMAGE_BYTES } from './review-media.util';
import { ReviewsService } from './reviews.service';

// PD-3: per-actor write limits, stricter than the global 100/min.
const WRITE_LIMIT = { default: { limit: 30, ttl: 60_000 } };
const VOTE_LIMIT = { default: { limit: 60, ttl: 60_000 } };
const MEDIA_LIMIT = { default: { limit: 20, ttl: 60_000 } };

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
  @Throttle(WRITE_LIMIT)
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
        fit_feedback: dto.fit_feedback,
        tags: dto.tags,
        author_display: dto.author_display,
      },
      req.correlationId,
    );
  }

  /** PD-3: the author's own review (for the edit form) - 404 for anyone else. */
  @Get(':id')
  async own(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string) {
    const customerId = await this.requireCustomerId(user);
    return this.reviews.ownReview(customerId, id);
  }

  @Patch(':id')
  @Throttle(WRITE_LIMIT)
  @UseInterceptors(IdempotencyInterceptor)
  async edit(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Body() dto: UpdateReviewDto,
    @Req() req: Request,
  ) {
    const customerId = await this.requireCustomerId(user);
    if (
      dto.rating === undefined &&
      dto.body === undefined &&
      dto.fit_feedback === undefined &&
      dto.tags === undefined &&
      dto.author_display === undefined
    ) {
      throw new BadRequestException({
        code: 'NOTHING_TO_UPDATE',
        message: 'Send at least one field to change',
      });
    }
    return this.reviews.edit(customerId, user.id, id, dto, req.correlationId);
  }

  @Delete(':id')
  @HttpCode(204)
  @Throttle(WRITE_LIMIT)
  @UseInterceptors(IdempotencyInterceptor)
  async remove(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Req() req: Request,
  ): Promise<void> {
    const customerId = await this.requireCustomerId(user);
    await this.reviews.remove(customerId, user.id, id, req.correlationId);
  }

  @Post(':id/helpful')
  @HttpCode(200)
  @Throttle(VOTE_LIMIT)
  async vote(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string) {
    const customerId = await this.requireCustomerId(user);
    return this.reviews.vote(customerId, user.id, id);
  }

  @Delete(':id/helpful')
  @Throttle(VOTE_LIMIT)
  async unvote(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
  ) {
    const customerId = await this.requireCustomerId(user);
    return this.reviews.unvote(customerId, id);
  }

  /**
   * PD-3: multipart `file` (JPEG/PNG/WebP, <= 5 MB), `consent=true`,
   * optional `alt_text` (<= 200 chars).
   */
  @Post(':id/media')
  @HttpCode(201)
  @Throttle(MEDIA_LIMIT)
  @UseInterceptors(
    FileInterceptor('file', {
      limits: { fileSize: MAX_REVIEW_IMAGE_BYTES, files: 1 },
    }),
    IdempotencyInterceptor,
  )
  async addMedia(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @UploadedFile() file: Express.Multer.File | undefined,
    @Body() body: { consent?: string; alt_text?: string },
    @Req() req: Request,
  ) {
    if (!file) {
      throw new BadRequestException({
        code: 'FILE_REQUIRED',
        message: 'An image must be uploaded under the "file" field',
      });
    }
    const altText =
      typeof body.alt_text === 'string' && body.alt_text.trim() !== ''
        ? body.alt_text.trim()
        : null;
    if (altText && [...altText].length > 200) {
      throw new BadRequestException({
        code: 'ALT_TEXT_TOO_LONG',
        message: 'The image description can be at most 200 characters',
      });
    }
    const customerId = await this.requireCustomerId(user);
    return this.reviews.addMedia(
      customerId,
      user.id,
      id,
      { buffer: file.buffer, altText, consent: body.consent === 'true' },
      req.correlationId,
    );
  }

  @Delete(':id/media/:mediaId')
  @HttpCode(204)
  @Throttle(WRITE_LIMIT)
  @UseInterceptors(IdempotencyInterceptor)
  async removeMedia(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Param('mediaId') mediaId: string,
    @Req() req: Request,
  ): Promise<void> {
    const customerId = await this.requireCustomerId(user);
    await this.reviews.removeMedia(
      customerId,
      user.id,
      id,
      mediaId,
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
      dto.media_id,
    );
  }
}
