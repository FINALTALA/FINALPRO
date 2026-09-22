import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { AuthModule } from '../auth/auth.module';
import { DeliveryWindowsController } from './delivery-windows.controller';

@Module({
  imports: [AuditModule, AuthModule],
  controllers: [DeliveryWindowsController],
})
export class DeliveryWindowsModule {}
