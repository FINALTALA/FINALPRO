import {
  Controller,
  Get,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Query,
  Res,
  UseGuards,
} from '@nestjs/common';
import { Response } from 'express';
import { existsSync } from 'fs';
import { PlatformRole } from '../../generated/prisma/client';
import { RequirePlatformRole } from '../auth/platform-role.decorator';
import { PlatformRoleGuard } from '../auth/platform-role.guard';
import { SessionAuthGuard } from '../auth/session-auth.guard';
import { VendorMembershipGuard } from '../auth/vendor-membership.guard';
import { RequireVendorRole } from '../auth/vendor-role.decorator';
import { ReviewsService } from './reviews.service';

const notFound = () =>
  new NotFoundException({
    code: 'REVIEW_MEDIA_NOT_FOUND',
    message: 'Image not found',
  });

function send(res: Response, file: string | null, cache: string) {
  if (!file || !existsSync(file)) throw notFound();
  res.setHeader('Content-Type', 'image/webp');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Content-Security-Policy', "default-src 'none'");
  res.setHeader('Cache-Control', cache);
  res.sendFile(file);
}

/**
 * PD-3 cache policy for public review images: `private` - no CDN or
 * shared proxy may store them; `no-cache, must-revalidate` - a browser
 * may keep its copy but must ask this server before every use. The
 * visibility check below runs on EVERY request (the image VISIBLE, its
 * review neither HIDDEN nor deleted) BEFORE sendFile() answers, so a
 * revalidation of a hidden or deleted image gets 404 at once, while an
 * unchanged visible one costs only a body-less 304 (sendFile's own
 * ETag/Last-Modified). Trade-off: one small round trip per display
 * instead of zero; no image bytes are re-sent.
 */
const PUBLIC_REVIEW_MEDIA_CACHE = 'private, no-cache, must-revalidate';

/** PD-3: review images are only ever served here. */
@Controller()
export class ReviewMediaController {
  constructor(private readonly reviews: ReviewsService) {}

  @Get('review-media/:id')
  async publicFile(
    @Param('id', new ParseUUIDPipe({ exceptionFactory: notFound })) id: string,
    @Res() res: Response,
  ) {
    send(
      res,
      await this.reviews.publicMediaFile(id),
      PUBLIC_REVIEW_MEDIA_CACHE,
    );
  }

  /** Any image, hidden ones too - the moderation queue's view. */
  @Get('admin/review-media/:id/file')
  @UseGuards(SessionAuthGuard, PlatformRoleGuard)
  @RequirePlatformRole(PlatformRole.PLATFORM_ADMIN)
  async adminFile(
    @Param('id', new ParseUUIDPipe({ exceptionFactory: notFound })) id: string,
    @Res() res: Response,
  ) {
    send(res, await this.reviews.adminMediaFile(id), 'private, no-store');
  }
}

/**
 * PD-3 (decision 11): the owner's read-only view of the reviews of what
 * their store sold and of the store itself. There is deliberately no
 * write route for a store - it can neither edit, delete nor reply
 * (replies are PD-3R). OWNER only, like the performance dashboard.
 */
@Controller('vendors/:vendorId/product-reviews')
@UseGuards(SessionAuthGuard, VendorMembershipGuard)
@RequireVendorRole('OWNER')
export class OwnerReviewsController {
  constructor(private readonly reviews: ReviewsService) {}

  @Get()
  async list(
    @Param('vendorId') vendorId: string,
    @Query('cursor') cursor?: string,
    @Query('limit') limit?: string,
    @Query('target') target?: string,
  ) {
    return this.reviews.ownerReviews(vendorId, {
      cursor,
      limit,
      target: target === 'PRODUCT' || target === 'STORE' ? target : undefined,
    });
  }
}
