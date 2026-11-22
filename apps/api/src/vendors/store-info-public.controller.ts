import { Controller, Get, NotFoundException, Param } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { isOpenNow } from './branch-operating-hours.util';

const UPCOMING_CLOSURES_LIMIT = 3;

// Sprint 26: the practical "before you order" facts for the public
// store page - branches with their opening hours and upcoming
// closures, the delivery regions this store actually delivers to (and
// at what fee), and its return policy. Unauthenticated, same as the
// other storefronts/:slug reads. Deliberately NOT included: branch
// coordinates (no customer-facing read anywhere exposes them; the
// warehouse stays hidden per PDR-010), closure reasons (free-text
// staff notes), and anything staff-only. Like /sections, an
// unavailable store answers with empty facts rather than a 404.
@Controller('storefronts/:slug')
export class StoreInfoPublicController {
  constructor(private readonly prisma: PrismaService) {}

  @Get('info')
  async getInfo(@Param('slug') slug: string) {
    const vendor = await this.prisma.vendor.findUnique({ where: { slug } });
    if (!vendor) {
      throw new NotFoundException({
        code: 'STOREFRONT_NOT_FOUND',
        message: 'No store found for this URL',
      });
    }
    if (!(vendor.storefrontPublished && vendor.status === 'ACTIVE')) {
      return { is_available: false, branches: [], delivery: [], returns: null };
    }

    const now = new Date();
    const [branches, zones] = await Promise.all([
      this.prisma.storeBranch.findMany({
        where: { vendorId: vendor.id, archivedAt: null },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        select: {
          id: true,
          name: true,
          isPhysical: true,
          operatingHours: {
            orderBy: { dayOfWeek: 'asc' },
            select: { dayOfWeek: true, openMinute: true, closeMinute: true },
          },
          closures: {
            where: { endsAt: { gt: now } },
            orderBy: { startsAt: 'asc' },
            take: UPCOMING_CLOSURES_LIMIT,
            select: { startsAt: true, endsAt: true },
          },
        },
      }),
      this.prisma.vendorDeliveryZone.findMany({
        where: { vendorId: vendor.id },
        orderBy: { region: 'asc' },
      }),
    ]);

    return {
      is_available: true,
      branches: branches.map((b) => {
        const closedNow = b.closures.some(
          (c) => c.startsAt <= now && c.endsAt > now,
        );
        return {
          id: b.id,
          name: b.name,
          is_physical: b.isPhysical,
          // null when the owner never set hours (unknown, not "closed").
          open_now:
            b.operatingHours.length === 0
              ? null
              : !closedNow && isOpenNow(b.operatingHours, now),
          hours: b.operatingHours.map((h) => ({
            day_of_week: h.dayOfWeek,
            open_minute: h.openMinute,
            close_minute: h.closeMinute,
          })),
          upcoming_closures: b.closures.map((c) => ({
            starts_at: c.startsAt.toISOString(),
            ends_at: c.endsAt.toISOString(),
          })),
        };
      }),
      // Same rule checkout uses: a region is deliverable only when it is
      // enabled AND the owner has priced it - never a guessed fee.
      delivery: zones
        .filter((z) => z.enabled && z.fee !== null)
        .map((z) => ({
          region: z.region,
          fee_ils: Number(z.fee),
          minimum_order_ils:
            z.minimumOrderValue !== null ? Number(z.minimumOrderValue) : null,
        })),
      returns: {
        mode: vendor.returnMode,
        window_days: vendor.returnWindowDays,
        fee_ils:
          vendor.returnFeeIls != null ? Number(vendor.returnFeeIls) : null,
        exchange_fee_ils:
          vendor.exchangeFeeIls != null ? Number(vendor.exchangeFeeIls) : null,
      },
    };
  }
}
