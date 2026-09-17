import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { AuthModule } from '../auth/auth.module';
import { SubscriptionsController } from './subscriptions.controller';

@Module({
  imports: [AuditModule, AuthModule],
  controllers: [SubscriptionsController],
})
export class SubscriptionsModule {}
