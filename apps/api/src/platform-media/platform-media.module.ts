import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { AuthModule } from '../auth/auth.module';
import { IdempotencyModule } from '../common/idempotency/idempotency.module';
import {
  AdminMediaController,
  MediaDeliveryController,
} from './media-library.controller';
import { MediaLibraryService } from './media-library.service';

/** VIA phase 5 - the platform Media Library. */
@Module({
  imports: [AuditModule, AuthModule, IdempotencyModule],
  controllers: [AdminMediaController, MediaDeliveryController],
  providers: [MediaLibraryService],
  exports: [MediaLibraryService],
})
export class PlatformMediaModule {}
