import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { AuthModule } from '../auth/auth.module';
import { MatchingModule } from '../matching/matching.module';
import { OutboxModule } from '../outbox/outbox.module';
import { OfferTaxonomyController } from './offer-taxonomy.controller';
import { StorefrontCatalogueController } from './storefront-catalogue.controller';
import { StoreTaxonomyPublicController } from './store-taxonomy-public.controller';
import { TaxonomyController } from './taxonomy.controller';
import { StoreCatalogService } from './store-catalog.service';
import { TaxonomyService } from './taxonomy.service';

// Sprint 27: imported by OffersModule (the taxonomy is part of the
// catalogue), which is how its controllers join the app.
@Module({
  imports: [AuditModule, AuthModule, MatchingModule, OutboxModule],
  controllers: [
    TaxonomyController,
    OfferTaxonomyController,
    StoreTaxonomyPublicController,
    StorefrontCatalogueController,
  ],
  // StoreCatalogService: the store page's catalogue, shared with the store's
  // home page blocks (store-home/, 2026-11-20).
  providers: [TaxonomyService, StoreCatalogService],
  exports: [TaxonomyService, StoreCatalogService],
})
export class TaxonomyModule {}
