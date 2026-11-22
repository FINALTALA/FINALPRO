import {
  Body,
  Controller,
  ForbiddenException,
  Get,
  Param,
  ParseUUIDPipe,
  Put,
  Req,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { Request } from 'express';
import { CurrentUser } from '../auth/current-user.decorator';
import {
  AuthenticatedUser,
  SessionAuthGuard,
} from '../auth/session-auth.guard';
import { VendorMembershipGuard } from '../auth/vendor-membership.guard';
import { RequireVendorRole } from '../auth/vendor-role.decorator';
import { BlockWhenSuspended } from '../auth/vendor-suspended.guard';
import { IdempotencyInterceptor } from '../common/idempotency/idempotency.interceptor';
import { PrismaService } from '../prisma/prisma.service';
import { SubscriptionGateService } from '../subscriptions/subscription-gate.service';
import { SetOfferPairingsDto } from './dto/set-offer-pairings.dto';
import { OfferPairingsService } from './offer-pairings.service';

const uuid = new ParseUUIDPipe({ version: '4' });

// PD-5.4 («نسّقي معه»): read by any member of the store (alongside the
// offer page they can already open); written by the OWNER only, never
// while the store is suspended or its subscription inactive.
@Controller('vendors/:vendorId/offers/:offerId/pairings')
@UseGuards(SessionAuthGuard, VendorMembershipGuard)
export class OfferPairingsController {
  constructor(
    private readonly pairings: OfferPairingsService,
    private readonly prisma: PrismaService,
    private readonly subscriptionGate: SubscriptionGateService,
  ) {}

  @Get()
  view(
    @Param('vendorId') vendorId: string,
    @Param('offerId', uuid) offerId: string,
  ) {
    return this.pairings.view(vendorId, offerId);
  }

  @Put()
  @RequireVendorRole('OWNER')
  @BlockWhenSuspended()
  @UseInterceptors(IdempotencyInterceptor)
  async replace(
    @Param('vendorId') vendorId: string,
    @Param('offerId', uuid) offerId: string,
    @Body() dto: SetOfferPairingsDto,
    @CurrentUser() user: AuthenticatedUser,
    @Req() req: Request,
  ) {
    // The same lazily-refreshed gate as offer creation, in its own
    // transaction (a lapse found here is recorded even though this call
    // is refused).
    const status = await this.prisma.$transaction((tx) =>
      this.subscriptionGate.refreshStatus(tx, vendorId, req.correlationId),
    );
    if (status !== 'ACTIVE') {
      throw new ForbiddenException({
        code: 'SUBSCRIPTION_INACTIVE',
        message: 'An active subscription is required to change pairings',
      });
    }
    return this.pairings.replace(
      user.id,
      req.correlationId,
      vendorId,
      offerId,
      dto.paired_offer_ids,
    );
  }
}
