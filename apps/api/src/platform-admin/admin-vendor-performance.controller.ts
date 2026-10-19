import {
  Controller,
  Get,
  NotFoundException,
  Query,
  UseGuards,
} from '@nestjs/common';
import { PlatformRole } from '../../generated/prisma/client';
import { RequirePlatformRole } from '../auth/platform-role.decorator';
import { PlatformRoleGuard } from '../auth/platform-role.guard';
import { SessionAuthGuard } from '../auth/session-auth.guard';
import { FeatureFlagsService } from '../feature-flags/feature-flags.service';
import { PrismaService } from '../prisma/prisma.service';
import { VendorPerformanceService } from '../vendor-performance/vendor-performance.service';
import {
  decodeCursor,
  encodeCursor,
  isIsoDateString,
  isUuidLike,
  parseLimit,
} from './cursor.util';

/**
 * Sprint 25 (FR-VEND-011, admin side): review-round fix - pagination
 * is keyed on `Vendor.createdAt`/`id` (a stable, indexed base), never
 * on any computed metric. Cancellation rate/response time/rating are
 * calculated only AFTER the page of vendors is already selected by
 * that stable order - a computed value shifts with every new order
 * that lands, which would make it an unsafe cursor key (a vendor
 * could be skipped or repeated across pages as its own numbers
 * change between requests).
 */
@Controller('admin/vendors/performance')
@UseGuards(SessionAuthGuard, PlatformRoleGuard)
export class AdminVendorPerformanceController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly vendorPerformance: VendorPerformanceService,
    private readonly featureFlags: FeatureFlagsService,
  ) {}

  @Get()
  @RequirePlatformRole(PlatformRole.PLATFORM_ADMIN)
  async list(
    @Query('cursor') cursor?: string,
    @Query('limit') limitRaw?: string,
  ) {
    const enabled = await this.featureFlags.isEnabled(
      'vendor_performance_dashboard_enabled',
    );
    if (!enabled) {
      throw new NotFoundException({
        code: 'FEATURE_DISABLED',
        message: 'This feature is not currently available',
      });
    }

    const limit = parseLimit(limitRaw);
    const cursorParts = decodeCursor(cursor, [isIsoDateString, isUuidLike]);

    const vendors = await this.prisma.vendor.findMany({
      where: cursorParts
        ? {
            OR: [
              { createdAt: { lt: new Date(cursorParts[0] as string) } },
              {
                createdAt: new Date(cursorParts[0] as string),
                id: { lt: cursorParts[1] as string },
              },
            ],
          }
        : {},
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: limit + 1,
      select: { id: true, legalName: true, displayName: true, createdAt: true },
    });
    const hasMore = vendors.length > limit;
    const page = vendors.slice(0, limit);
    const last = page[page.length - 1];

    const items = await Promise.all(
      page.map(async (v) => {
        const performance = await this.vendorPerformance.computeForVendor(v.id);
        return {
          display_name: v.displayName ?? v.legalName,
          ...performance,
        };
      }),
    );

    return {
      items,
      next_cursor:
        hasMore && last
          ? encodeCursor([last.createdAt.toISOString(), last.id])
          : null,
    };
  }
}
