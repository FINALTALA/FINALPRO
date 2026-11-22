import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { AuthModule } from '../auth/auth.module';
import { FeatureFlagsModule } from '../feature-flags/feature-flags.module';
import { TaxonomyModule } from '../taxonomy/taxonomy.module';
import { StoreHomePublicController } from './store-home-public.controller';
import { StoreHomeController } from './store-home.controller';
import { StoreHomeService } from './store-home.service';

/** «الصفحة الرئيسية المرنة للمتجر» (2026-11-20) - behind `store_home_blocks_enabled`. */
@Module({
  imports: [AuditModule, AuthModule, FeatureFlagsModule, TaxonomyModule],
  controllers: [StoreHomeController, StoreHomePublicController],
  providers: [StoreHomeService],
})
export class StoreHomeModule {}
