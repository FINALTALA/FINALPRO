import { Global, Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { AuthModule } from '../auth/auth.module';
import { IdempotencyModule } from '../common/idempotency/idempotency.module';
import {
  AdminSizeGuidesController,
  OwnerSizeGuidesController,
  PublicSizeGuidesController,
} from './size-guides.controller';
import { SizeGuidesService } from './size-guides.service';

// PD-4 (PD-FR-003): size guides. Global, like FulfilmentModule: the
// product detail, the publish gate and checkout all read the same
// resolution (SizeGuidesService) without wiring their modules to it.
@Global()
@Module({
  imports: [AuditModule, AuthModule, IdempotencyModule],
  controllers: [
    AdminSizeGuidesController,
    OwnerSizeGuidesController,
    PublicSizeGuidesController,
  ],
  providers: [SizeGuidesService],
  exports: [SizeGuidesService],
})
export class SizeGuidesModule {}
