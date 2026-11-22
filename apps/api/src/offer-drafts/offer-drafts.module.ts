import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { AuthModule } from '../auth/auth.module';
import { FeatureFlagsModule } from '../feature-flags/feature-flags.module';
import { MatchingModule } from '../matching/matching.module';
import { OutboxModule } from '../outbox/outbox.module';
import { StorePosModule } from '../store-pos/store-pos.module';
import { OffersModule } from '../offers/offers.module';
import { TaxonomyModule } from '../taxonomy/taxonomy.module';
import { BrandRequestsService } from './brand-requests.service';
import { BulkPublishController } from './bulk-publish.controller';
import { BulkPublishService } from './bulk-publish.service';
import { DraftUploadSweepService } from './draft-upload-sweep.service';
import {
  AdminBrandRequestsController,
  OfferDraftsController,
  VendorBrandRequestsController,
  VendorUnpublishedProductsController,
} from './offer-drafts.controller';
import { OfferDraftsService } from './offer-drafts.service';
import { OfferEditDraftsService } from './offer-edit-drafts.service';

/** Product-entry wizard: server-side drafts of new products, and brand requests. */
@Module({
  imports: [
    AuditModule,
    AuthModule,
    FeatureFlagsModule,
    OffersModule,
    TaxonomyModule,
    MatchingModule,
    OutboxModule,
    StorePosModule,
  ],
  controllers: [
    OfferDraftsController,
    VendorBrandRequestsController,
    VendorUnpublishedProductsController,
    AdminBrandRequestsController,
    BulkPublishController,
  ],
  providers: [
    OfferDraftsService,
    OfferEditDraftsService,
    BrandRequestsService,
    DraftUploadSweepService,
    BulkPublishService,
  ],
  exports: [OfferDraftsService, DraftUploadSweepService],
})
export class OfferDraftsModule {}
