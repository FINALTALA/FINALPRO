import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { AuthModule } from '../auth/auth.module';
import { OfferDraftsModule } from '../offer-drafts/offer-drafts.module';
import { StorePosModule } from '../store-pos/store-pos.module';
import { SubscriptionsModule } from '../subscriptions/subscriptions.module';
import { TaxonomyModule } from '../taxonomy/taxonomy.module';
import { ImportStagingSweepService } from './import-staging-sweep.service';
import { ProductImportController } from './product-import.controller';
import { ProductImportService } from './product-import.service';

/** The product import (2026-11-18): XLSX + a ZIP of images -> complete wizard drafts (checked first, confirmed all or none). */
@Module({
  imports: [
    AuditModule,
    AuthModule,
    OfferDraftsModule,
    StorePosModule,
    SubscriptionsModule,
    TaxonomyModule,
  ],
  controllers: [ProductImportController],
  providers: [ProductImportService, ImportStagingSweepService],
})
export class ProductImportModule {}
