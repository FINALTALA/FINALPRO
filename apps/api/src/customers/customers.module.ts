import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { AuthModule } from '../auth/auth.module';
import { IdempotencyModule } from '../common/idempotency/idempotency.module';
import { CustomersController } from './customers.controller';

@Module({
  // Sprint 22: IdempotencyModule added directly - AuthModule imports it
  // too but does not export it (Nest module re-exports require an
  // explicit `exports` entry), so CustomersController's own
  // IdempotencyCompletionService injection (phone-change) needs it
  // here independently.
  imports: [AuditModule, AuthModule, IdempotencyModule],
  controllers: [CustomersController],
})
export class CustomersModule {}
