import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { CartController } from './cart.controller';

@Module({
  imports: [AuthModule],
  controllers: [CartController],
})
export class CartModule {}
