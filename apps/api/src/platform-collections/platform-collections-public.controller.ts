import {
  BadRequestException,
  Controller,
  Get,
  Param,
  Query,
  Req,
} from '@nestjs/common';
import { Request } from 'express';
import { ProductAudience } from '../../generated/prisma/client';
import { optionalSessionUserId } from '../auth/optional-session';
import { SessionService } from '../auth/session.service';
import { FulfilmentEligibilityService } from '../fulfilment/fulfilment-eligibility.service';
import { PrismaService } from '../prisma/prisma.service';
import {
  CollectionPlacement,
  PLACEMENTS,
  PlatformCollectionsPublicService,
} from './platform-collections-public.service';

const AUDIENCES = Object.values(ProductAudience);

// PD-5b.2: public, unauthenticated reads of the platform collections. The
// shopper's zone is the `zone` query, else their default address when
// signed in (never GPS) - the same resolution the product page uses.
@Controller('collections')
export class PlatformCollectionsPublicController {
  constructor(
    private readonly collections: PlatformCollectionsPublicService,
    private readonly fulfilment: FulfilmentEligibilityService,
    private readonly sessions: SessionService,
    private readonly prisma: PrismaService,
  ) {}

  private async zoneChoice(raw: string | undefined, req: Request) {
    return this.fulfilment.resolveZone(
      raw,
      await optionalSessionUserId(this.sessions, this.prisma, req),
    );
  }

  @Get()
  async placement(
    @Query('placement') placementRaw: string | undefined,
    @Query('audience') audienceRaw: string | undefined,
    @Query('zone') zoneRaw: string | undefined,
    @Req() req: Request,
  ) {
    const placement = placementRaw?.trim().toUpperCase() as CollectionPlacement;
    if (!PLACEMENTS.includes(placement)) {
      throw new BadRequestException({
        code: 'INVALID_PLACEMENT',
        message: `placement must be one of ${PLACEMENTS.join(', ')}`,
      });
    }
    const audience = audienceRaw?.trim().toUpperCase() as
      ProductAudience | undefined;
    if (audience && !AUDIENCES.includes(audience)) {
      throw new BadRequestException({
        code: 'INVALID_AUDIENCE',
        message: `audience must be one of ${AUDIENCES.join(', ')}`,
      });
    }
    return this.collections.placement(
      placement,
      audience ?? null,
      (await this.zoneChoice(zoneRaw, req)).zone,
    );
  }

  @Get(':slug')
  async bySlug(
    @Param('slug') slug: string,
    @Query('zone') zoneRaw: string | undefined,
    @Req() req: Request,
  ) {
    // The zone that was applied and the account's default zone - the same
    // fulfilment_context the product page returns, so the shared zone
    // picker labels "my address" from the server, not from the browser.
    const choice = await this.zoneChoice(zoneRaw, req);
    return {
      ...(await this.collections.bySlug(slug, choice.zone)),
      fulfilment_context: choice,
    };
  }
}
