import {
  ConflictException,
  Controller,
  Delete,
  Get,
  HttpCode,
  NotFoundException,
  Param,
  Put,
  Query,
  UseGuards,
} from '@nestjs/common';
import { CurrentUser } from '../auth/current-user.decorator';
import {
  AuthenticatedUser,
  SessionAuthGuard,
} from '../auth/session-auth.guard';
import { PrismaService } from '../prisma/prisma.service';
import { ComparisonService, eligibleProductWhere } from './comparison.service';
import { comparisonCardDto } from './dto/comparison-card.dto';

const DEFAULT_PAGE_SIZE = 20;
const MAX_PAGE_SIZE = 50;

function clampInt(
  raw: string | undefined,
  fallback: number,
  min: number,
  max: number,
): number {
  const parsed = raw === undefined ? NaN : Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

// Sprint 13 (RB-STOREF-003, PDR-002 / approved baseline 3.1 "Following"):
// the stores the signed-in customer follows. Every route is scoped to
// the SESSION user - there is no user id in any URL or body, so one
// account can never read or change another's follows. A store is
// followable, listed and fed only while it is published AND ACTIVE; an
// existing follow of a store that later becomes unavailable is kept
// (not deleted) but hidden until the store is available again. Not a
// social feature: no follower counts, no notifications.
@Controller('customers/me/following')
@UseGuards(SessionAuthGuard)
export class FollowingController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly comparison: ComparisonService,
  ) {}

  @Get()
  async list(@CurrentUser() user: AuthenticatedUser) {
    const follows = await this.prisma.storeFollow.findMany({
      where: {
        userId: user.id,
        vendor: { storefrontPublished: true, status: 'ACTIVE' },
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      include: {
        vendor: {
          select: {
            slug: true,
            displayName: true,
            legalName: true,
            logoUrl: true,
          },
        },
      },
    });
    return {
      items: follows.map((f) => ({
        slug: f.vendor.slug,
        display_name: f.vendor.displayName ?? f.vendor.legalName,
        logo_url: f.vendor.logoUrl,
        followed_at: f.createdAt.toISOString(),
      })),
    };
  }

  @Get('feed')
  async feed(
    @CurrentUser() user: AuthenticatedUser,
    @Query('page') pageRaw?: string,
    @Query('page_size') pageSizeRaw?: string,
  ) {
    const page = clampInt(pageRaw, 1, 1, 1_000_000);
    const pageSize = clampInt(pageSizeRaw, DEFAULT_PAGE_SIZE, 1, MAX_PAGE_SIZE);
    const where = eligibleProductWhere({
      followers: { some: { userId: user.id } },
    });
    const { total, cards } = await this.comparison.listCards(
      where,
      page,
      pageSize,
    );
    return {
      page,
      page_size: pageSize,
      total,
      items: cards.map(comparisonCardDto),
    };
  }

  @Get(':slug')
  async status(
    @CurrentUser() user: AuthenticatedUser,
    @Param('slug') slug: string,
  ) {
    const follow = await this.prisma.storeFollow.findFirst({
      where: { userId: user.id, vendor: { slug } },
    });
    return { following: follow !== null };
  }

  @Put(':slug')
  async follow(
    @CurrentUser() user: AuthenticatedUser,
    @Param('slug') slug: string,
  ) {
    const vendor = await this.prisma.vendor.findUnique({ where: { slug } });
    if (!vendor) {
      throw new NotFoundException({
        code: 'STOREFRONT_NOT_FOUND',
        message: 'No store found for this URL',
      });
    }
    if (!vendor.storefrontPublished || vendor.status !== 'ACTIVE') {
      throw new ConflictException({
        code: 'STORE_UNAVAILABLE',
        message: 'This store is not available to follow right now',
      });
    }
    await this.prisma.storeFollow.upsert({
      where: { userId_vendorId: { userId: user.id, vendorId: vendor.id } },
      create: { userId: user.id, vendorId: vendor.id },
      update: {},
    });
    return { following: true };
  }

  @Delete(':slug')
  @HttpCode(200)
  async unfollow(
    @CurrentUser() user: AuthenticatedUser,
    @Param('slug') slug: string,
  ) {
    await this.prisma.storeFollow.deleteMany({
      where: { userId: user.id, vendor: { slug } },
    });
    return { following: false };
  }
}
