import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { AuthModule } from '../auth/auth.module';
import { UploadsController } from './uploads.controller';

@Module({
  imports: [AuditModule, AuthModule],
  controllers: [UploadsController],
})
export class UploadsModule {}
