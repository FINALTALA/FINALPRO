import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { AuthModule } from '../auth/auth.module';
import { IdempotencyModule } from '../common/idempotency/idempotency.module';
import { CanonicalProductsController } from './canonical-products.controller';
import { MatchingService } from './matching.service';

@Module({
  imports: [AuditModule, AuthModule, IdempotencyModule],
  controllers: [CanonicalProductsController],
  providers: [MatchingService],
  exports: [MatchingService],
})
export class MatchingModule {}
