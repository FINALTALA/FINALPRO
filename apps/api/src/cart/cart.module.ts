import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { IdempotencyModule } from '../common/idempotency/idempotency.module';
import { SubscriptionsModule } from '../subscriptions/subscriptions.module';
import { CartController } from './cart.controller';

@Module({
  imports: [AuthModule, IdempotencyModule, SubscriptionsModule],
  controllers: [CartController],
})
export class CartModule {}
