import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { HealthController } from './health.controller';

@Module({
  imports: [AuditModule],
  controllers: [HealthController],
})
export class HealthModule {}
