import { MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { AuditModule } from './audit/audit.module';
import { AuthModule } from './auth/auth.module';
import { CartModule } from './cart/cart.module';
import { CatalogModule } from './catalog/catalog.module';
import { CheckoutModule } from './checkout/checkout.module';
import { CorrelationIdMiddleware } from './common/middleware/correlation-id.middleware';
import { CustomersModule } from './customers/customers.module';
import { DeliveryWindowsModule } from './delivery-windows/delivery-windows.module';
import { DiscoveryModule } from './discovery/discovery.module';
import { FavoritesModule } from './favorites/favorites.module';
import { FeatureFlagsModule } from './feature-flags/feature-flags.module';
import { HealthModule } from './health/health.module';
import { InventoryModule } from './inventory/inventory.module';
import { MatchingModule } from './matching/matching.module';
import { OffersModule } from './offers/offers.module';
import { OfferDraftsModule } from './offer-drafts/offer-drafts.module';
import { ProductImportModule } from './product-import/product-import.module';
import { OrdersModule } from './orders/orders.module';
import { OutboxModule } from './outbox/outbox.module';
import { PlatformAdminModule } from './platform-admin/platform-admin.module';
import { PlatformAlertsModule } from './platform-alerts/platform-alerts.module';
import { PrismaModule } from './prisma/prisma.module';
import { RedisModule } from './redis/redis.module';
import { ReturnsModule } from './returns/returns.module';
import { ReviewsModule } from './reviews/reviews.module';
import { SubscriptionsModule } from './subscriptions/subscriptions.module';
import { TestSupportModule } from './test-support/test-support.module';
import { FulfilmentModule } from './fulfilment/fulfilment.module';
import { SizeGuidesModule } from './size-guides/size-guides.module';
import { SalesRankModule } from './sales-rank/sales-rank.module';
import { OfferPairingsModule } from './offer-pairings/offer-pairings.module';
import { PlatformCollectionsModule } from './platform-collections/platform-collections.module';
import { VendorPerformanceModule } from './vendor-performance/vendor-performance.module';
import { StorePosModule } from './store-pos/store-pos.module';
import { StoreHomeModule } from './store-home/store-home.module';
import { VendorVerificationModule } from './vendor-verification/vendor-verification.module';
import { UploadsModule } from './uploads/uploads.module';
import { VendorsModule } from './vendors/vendors.module';
import { WarehouseVerificationModule } from './warehouse-verification/warehouse-verification.module';

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
    CatalogModule,
    MatchingModule,
    OffersModule,
    OfferDraftsModule,
    ProductImportModule,
    VendorVerificationModule,
    WarehouseVerificationModule,
    PlatformAdminModule,
    PlatformAlertsModule,
    SubscriptionsModule,
    FulfilmentModule,
    SizeGuidesModule,
    SalesRankModule,
    OfferPairingsModule,
    PlatformCollectionsModule,
    InventoryModule,
    DiscoveryModule,
    OrdersModule,
    DeliveryWindowsModule,
    CartModule,
    CheckoutModule,
    ReturnsModule,
    ReviewsModule,
    FavoritesModule,
    FeatureFlagsModule,
    VendorPerformanceModule,
    // Barcodes and in-store sales (2026-11-20), behind store_cashier_enabled.
    StorePosModule,
    // The store's flexible home page (2026-11-20), behind store_home_blocks_enabled.
    StoreHomeModule,
    UploadsModule,
    // TB-12.1: 404 everywhere unless E2E_TEST_SUPPORT=1 outside production.
    TestSupportModule,
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
