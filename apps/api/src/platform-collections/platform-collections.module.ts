import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { AuthModule } from '../auth/auth.module';
import { IdempotencyModule } from '../common/idempotency/idempotency.module';
import { DiscoveryModule } from '../discovery/discovery.module';
import { AdminPlatformCollectionsController } from './admin-platform-collections.controller';
import { PlatformCollectionsPublicController } from './platform-collections-public.controller';
import { PlatformCollectionsPublicService } from './platform-collections-public.service';
import { PlatformCollectionsService } from './platform-collections.service';

@Module({
  imports: [AuditModule, AuthModule, IdempotencyModule, DiscoveryModule],
  controllers: [
    AdminPlatformCollectionsController,
    PlatformCollectionsPublicController,
  ],
  providers: [PlatformCollectionsService, PlatformCollectionsPublicService],
})
export class PlatformCollectionsModule {}
