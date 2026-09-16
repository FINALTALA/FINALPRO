import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { AuthModule } from '../auth/auth.module';
import { VendorsController } from './vendors.controller';

@Module({
  imports: [AuditModule, AuthModule],
  controllers: [VendorsController],
})
export class VendorsModule {}
