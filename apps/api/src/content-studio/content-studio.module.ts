import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { AuthModule } from '../auth/auth.module';
import { IdempotencyModule } from '../common/idempotency/idempotency.module';
import {
  AdminContentController,
  PublicContentController,
} from './content-studio.controller';
import { ContentStudioService } from './content-studio.service';

/** VIA phase 6 - Content Studio (Homepage, Trending, the editorial Ads page). */
@Module({
  imports: [AuditModule, AuthModule, IdempotencyModule],
  controllers: [AdminContentController, PublicContentController],
  providers: [ContentStudioService],
})
export class ContentStudioModule {}
