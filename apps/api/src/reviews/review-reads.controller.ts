import { Controller, Get, Param, Query, Req } from '@nestjs/common';
import { Request } from 'express';
import { optionalSessionUserId } from '../auth/optional-session';
import { SessionService } from '../auth/session.service';
import { PrismaService } from '../prisma/prisma.service';
import { ProductReviewsQueryDto } from './dto/product-reviews-query.dto';
import { ReviewReadsService } from './review-reads.service';
import { ReviewsService } from './reviews.service';

// Sprint 23 (PDR-032): public, unauthenticated reads - every
// non-HIDDEN review (VISIBLE and REPORTED both stay public; only an
// admin's uphold decision removes one from this list) plus the
// aggregate rating (ReviewsService counts VISIBLE only toward it, and
// withholds the average below 3). Kept separate from ReviewsController
// (which is customer-auth'd and mutating) rather than added onto
// either's existing public controller, matching the per-feature-
// module controller convention (see ReturnsModule's three).
@Controller()
export class ReviewReadsController {
  constructor(
    private readonly reviews: ReviewsService,
    private readonly reads: ReviewReadsService,
    private readonly sessions: SessionService,
    private readonly prisma: PrismaService,
  ) {}

  // PD-3: paginated, filtered, with the summary; a signed-in viewer
  // also gets their own vote/edit/report state per review (a missing
  // or stale token is simply a guest, never a 401).
  @Get('canonical-products/:id/reviews')
  async forProduct(
    @Param('id') id: string,
    @Query() query: ProductReviewsQueryDto,
    @Req() req: Request,
  ) {
    const userId = await optionalSessionUserId(this.sessions, this.prisma, req);
    return this.reads.listForProduct(id, query, userId);
  }

  @Get('vendors/:vendorId/reviews')
  async forVendor(@Param('vendorId') vendorId: string) {
    return this.reviews.listForVendor(vendorId);
  }

  // The public storefront is addressed by slug, never by raw vendor
  // id (see StorefrontPublicController's own comment) - this mirrors
  // that convention for the frontend rather than exposing vendorId.
  @Get('storefronts/:slug/reviews')
  async forStorefrontSlug(@Param('slug') slug: string) {
    return this.reviews.listForVendorSlug(slug);
  }
}
