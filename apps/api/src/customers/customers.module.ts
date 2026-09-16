import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { AuthModule } from '../auth/auth.module';
import { CustomersController } from './customers.controller';

@Module({
  imports: [AuditModule, AuthModule],
  controllers: [CustomersController],
})
export class CustomersModule {}
