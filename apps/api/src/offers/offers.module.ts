import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { AuthModule } from '../auth/auth.module';
import { MatchingModule } from '../matching/matching.module';
import { VendorOffersController } from './vendor-offers.controller';

@Module({
  imports: [AuditModule, AuthModule, MatchingModule],
  controllers: [VendorOffersController],
})
export class OffersModule {}
