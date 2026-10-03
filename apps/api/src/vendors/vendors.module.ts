import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { AuthModule } from '../auth/auth.module';
import { IdempotencyModule } from '../common/idempotency/idempotency.module';
import { BranchClosuresController } from './branch-closures.controller';
import { BranchOperatingHoursController } from './branch-operating-hours.controller';
import { StaffController } from './staff.controller';
import { StoreOffersPublicController } from './store-offers-public.controller';
import { StoreSectionsController } from './store-sections.controller';
import { StorefrontPublicController } from './storefront-public.controller';
import { StorefrontController } from './storefront.controller';
import { VendorsController } from './vendors.controller';

@Module({
  imports: [AuditModule, AuthModule, IdempotencyModule],
  controllers: [
    VendorsController,
    StorefrontController,
    StorefrontPublicController,
    StoreSectionsController,
    StoreOffersPublicController,
    BranchOperatingHoursController,
    BranchClosuresController,
    StaffController,
  ],
})
export class VendorsModule {}
