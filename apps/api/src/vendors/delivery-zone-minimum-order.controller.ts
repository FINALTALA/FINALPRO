import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Param,
  Put,
  Req,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { Request } from 'express';
import { AuditLogService } from '../audit/audit-log.service';
import { CurrentUser } from '../auth/current-user.decorator';
import {
  AuthenticatedUser,
  SessionAuthGuard,
} from '../auth/session-auth.guard';
import { VendorMembershipGuard } from '../auth/vendor-membership.guard';
import { RequireVendorRole } from '../auth/vendor-role.decorator';
import { IdempotencyInterceptor } from '../common/idempotency/idempotency.interceptor';
import { PrismaService } from '../prisma/prisma.service';
import { DeliveryZoneRegion } from '../../generated/prisma/client';
import { UpdateMinimumOrderValueDto } from './dto/update-minimum-order-value.dto';

// Same static placeholder zone list as vendors.controller.ts's own
// ALL_DELIVERY_ZONE_REGIONS (see that file's comment - OPEN-012 is
// still unresolved) - duplicated locally rather than exported/shared,
// matching this codebase's own established convention for small,
// per-file constants.
const ALL_DELIVERY_ZONE_REGIONS: DeliveryZoneRegion[] = [
  'WEST_BANK',
  'JERUSALEM',
  'INSIDE',
];

function minimumOrderValueDto(value: unknown) {
  return { minimum_order_value: value != null ? Number(value) : null };
}

// Sprint 20b (FR-PRICE-006, FR-CART-003): an OPTIONAL override of the
// branch's own default (BranchMinimumOrderController) for DELIVERY
// orders into this one region only - null (the default for every
// region until an owner sets one) means "no override, use the
// branch's own default". PICKUP never reads this controller's value
// at all. A separate endpoint from the existing fee/enabled
// PUT .../delivery-zones/:region - that one has no Idempotency-Key
// today and this review round's convention requires one here, so
// this stays its own small, independently-idempotent surface rather
// than retrofitting the existing endpoint's contract.
@Controller('vendors/:vendorId/delivery-zones/:region/minimum-order')
@UseGuards(SessionAuthGuard, VendorMembershipGuard)
export class DeliveryZoneMinimumOrderController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auditLog: AuditLogService,
  ) {}

  private requireValidRegion(region: string): DeliveryZoneRegion {
    if (!ALL_DELIVERY_ZONE_REGIONS.includes(region as DeliveryZoneRegion)) {
      throw new BadRequestException({
        code: 'INVALID_DELIVERY_ZONE_REGION',
        message: `region must be one of ${ALL_DELIVERY_ZONE_REGIONS.join(', ')}`,
      });
    }
    return region as DeliveryZoneRegion;
  }

  @Get()
  async get(
    @Param('vendorId') vendorId: string,
    @Param('region') region: string,
  ) {
    const typedRegion = this.requireValidRegion(region);
    const zone = await this.prisma.vendorDeliveryZone.findUnique({
      where: { vendorId_region: { vendorId, region: typedRegion } },
    });
    return minimumOrderValueDto(zone?.minimumOrderValue ?? null);
  }

  // Idempotency-Key required; AuditLog only on a real change - same
  // convention as BranchMinimumOrderController's own PUT.
  //
  // Review-round fix: unlike the branch controller, a region an owner
  // never touched has NO VendorDeliveryZone row yet - `FOR UPDATE`
  // cannot lock a row that doesn't exist, so a plain unlocked read of
  // `existing` had the exact same before/after race as the branch
  // controller did, PLUS a second hazard: two concurrent first-ever
  // PUTs for the same (vendorId, region) both seeing no row and both
  // attempting to create one. The unique constraint on
  // (vendorId, region) means Postgres would still only ever persist
  // one final row (no actual duplicate), but without a lock, both
  // requests' AuditLog writes would claim `before: null`, even though
  // the second one to commit was really changing the FIRST one's
  // value. A Postgres advisory lock keyed by (vendorId, region) - same
  // pattern as inviteStaff's own `pg_advisory_xact_lock` - serializes
  // the two regardless of whether a row exists yet, so the second
  // transaction always re-reads what the first one just committed.
  @Put()
  @RequireVendorRole('OWNER')
  @UseInterceptors(IdempotencyInterceptor)
  async update(
    @Param('vendorId') vendorId: string,
    @Param('region') region: string,
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: UpdateMinimumOrderValueDto,
    @Req() req: Request,
  ) {
    const typedRegion = this.requireValidRegion(region);
    return this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('finalpro:delivery_zone_minimum:' || ${vendorId} || ':' || ${typedRegion}))`;
      const existing = await tx.vendorDeliveryZone.findUnique({
        where: { vendorId_region: { vendorId, region: typedRegion } },
      });
      const before =
        existing?.minimumOrderValue != null
          ? Number(existing.minimumOrderValue)
          : null;
      const after = dto.minimum_order_value;

      if (before === after) {
        return minimumOrderValueDto(before);
      }

      // upsert: a region an owner never touched yet (no row at all,
      // same lazy-default convention as `enabled`/`fee`) still needs a
      // row created the first time a minimum is actually set. `enabled`
      // defaults to its own column default (true) on create, matching
      // the existing fee/enabled endpoint's own untouched-field
      // behaviour - this endpoint only ever writes minimumOrderValue.
      // Safe here (no duplicate-create race) because the advisory lock
      // above already serializes every concurrent call for this exact
      // (vendorId, region).
      const zone = await tx.vendorDeliveryZone.upsert({
        where: { vendorId_region: { vendorId, region: typedRegion } },
        create: {
          vendorId,
          region: typedRegion,
          minimumOrderValue: after,
        },
        update: { minimumOrderValue: after },
      });
      await this.auditLog.record(
        {
          actorId: user.id,
          correlationId: req.correlationId,
          action: 'vendor_delivery_zone.minimum_order_value_updated',
          entityType: 'VendorDeliveryZone',
          entityId: zone.id,
          beforeState: { minimum_order_value: before },
          afterState: { minimum_order_value: after },
        },
        tx,
      );
      return minimumOrderValueDto(zone.minimumOrderValue);
    });
  }
}
