import { MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { AuditModule } from './audit/audit.module';
import { AuthModule } from './auth/auth.module';
import { CorrelationIdMiddleware } from './common/middleware/correlation-id.middleware';
import { CustomersModule } from './customers/customers.module';
import { HealthModule } from './health/health.module';
import { OutboxModule } from './outbox/outbox.module';
import { PrismaModule } from './prisma/prisma.module';
import { RedisModule } from './redis/redis.module';
import { VendorsModule } from './vendors/vendors.module';

@Module({
  imports: [
    // Part 4, H.1: per-actor rate limiting. This default (100 req/min)
    // is deliberately generous for Foundation; auth/OTP endpoints get a
    // materially stricter limit of their own (FR-AUTH-011), via a
    // route-level @Throttle() override (see AuthController).
    ThrottlerModule.forRoot([{ ttl: 60_000, limit: 100 }]),
    PrismaModule,
    RedisModule,
    AuditModule,
    OutboxModule,
    HealthModule,
    AuthModule,
    CustomersModule,
    VendorsModule,
  ],
  providers: [
    {
      provide: APP_GUARD,
      useClass: ThrottlerGuard,
    },
  ],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer) {
    consumer.apply(CorrelationIdMiddleware).forRoutes('*');
  }
}
