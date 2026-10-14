import { Controller, Get, Param } from '@nestjs/common';
import { ReviewsService } from './reviews.service';

// Sprint 23 (PDR-032): public, unauthenticated reads - VISIBLE
// reviews plus the aggregate rating (ReviewsService itself withholds
// the average below 3 reviews). Kept separate from ReviewsController
// (which is customer-auth'd and mutating) rather than added onto
// either's existing public controller, matching the per-feature-
// module controller convention (see ReturnsModule's three).
@Controller()
export class ReviewReadsController {
  constructor(private readonly reviews: ReviewsService) {}

  @Get('canonical-products/:id/reviews')
  async forProduct(@Param('id') id: string) {
    return this.reviews.listForProduct(id);
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
