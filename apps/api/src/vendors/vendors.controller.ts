import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  ForbiddenException,
  Get,
  HttpCode,
  NotFoundException,
  Param,
  Post,
  Put,
  Req,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { randomUUID } from 'crypto';
import { Request } from 'express';
import { AuditLogService } from '../audit/audit-log.service';
import { CurrentUser } from '../auth/current-user.decorator';
import { CurrentVendorMembership } from '../auth/current-vendor-membership.decorator';
import { OtpService } from '../auth/otp.service';
import {
  AuthenticatedUser,
  SessionAuthGuard,
} from '../auth/session-auth.guard';
import {
  VendorMembership,
  VendorMembershipGuard,
} from '../auth/vendor-membership.guard';
import { RequireVendorRole } from '../auth/vendor-role.decorator';
import { DeliveryZoneRegion, Prisma } from '../../generated/prisma/client';
import { IdempotencyCompletionService } from '../common/idempotency/idempotency-completion.service';
import { IdempotencyInterceptor } from '../common/idempotency/idempotency.interceptor';
import { generateVendorSlug } from '../common/slug.util';
import { PrismaService } from '../prisma/prisma.service';
import { CreatePickupPointDto } from './dto/create-pickup-point.dto';
import { CreateVendorDto } from './dto/create-vendor.dto';
import { InviteStaffDto } from './dto/invite-staff.dto';
import { UpdateDeliveryZoneDto } from './dto/update-delivery-zone.dto';
import { UpdateStoreTypeDto } from './dto/update-store-type.dto';
import { UpsertWarehouseDto } from './dto/upsert-warehouse.dto';

const STAFF_INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
// Sprint 5 (RB-STORE-002, PDR-022): the static placeholder zone list -
// see VendorDeliveryZone's schema comment for why this is not a
// geocoded lookup (OPEN-012 is still unresolved).
const ALL_DELIVERY_ZONE_REGIONS: DeliveryZoneRegion[] = [
  'WEST_BANK',
  'JERUSALEM',
  'INSIDE',
];

function branchSummaryDto(branch: {
  id: string;
  vendorId: string;
  name: string;
  isPhysical: boolean;
  verificationStatus: string;
}) {
  return {
    id: branch.id,
    vendor_id: branch.vendorId,
    name: branch.name,
    is_physical: branch.isPhysical,
    verification_status: branch.verificationStatus,
  };
}

// Sprint 5 (RB-STORE-001): deliberately excludes Warehouse entirely -
// PDR-010 calls it "hidden," and this is the one vendor-summary
// serializer every vendor-scoped read in this controller funnels
// through. Do not add a warehouse field here.
function vendorSummaryDto(vendor: {
  id: string;
  legalName: string;
  status: string;
  storeType: string;
}) {
  return {
    id: vendor.id,
    legal_name: vendor.legalName,
    status: vendor.status,
    store_type: vendor.storeType,
  };
}

// Sprint 5 review-round fix: only ever returned by the owner-only
// GET :vendorId/warehouse route below - never mixed into
// vendorSummaryDto() or any other general-membership/public response.
function warehouseDto(warehouse: {
  id: string;
  vendorId: string;
  lat: number | null;
  lng: number | null;
  addressNote: string | null;
}) {
  return {
    id: warehouse.id,
    vendor_id: warehouse.vendorId,
    lat: warehouse.lat,
    lng: warehouse.lng,
    address_note: warehouse.addressNote,
  };
}

function pickupPointDto(point: {
  id: string;
  vendorId: string;
  name: string;
  lat: number | null;
  lng: number | null;
  addressNote: string | null;
  isActive: boolean;
}) {
  return {
    id: point.id,
    vendor_id: point.vendorId,
    name: point.name,
    lat: point.lat,
    lng: point.lng,
    address_note: point.addressNote,
    is_active: point.isActive,
  };
}

// FR-VEND-001 / BL-VEND-001: any authenticated user can submit a
// vendor application - there's no separate "vendor applicant" role.
// Idempotency-Key is required here (not explicitly called out for this
// route in Part 4, H.3's fully-specified list, but well within H.1's
// general rule for a mutating endpoint that creates a real business
// resource): a flaky network retry on this form must not silently
// create two vendor applications. Being authenticated + idempotent
// together also makes this the natural home for the scope-isolation
// coverage EPIC-FOUND's Sprint 1 review deferred to Sprint 2 - see
// vendors.e2e-spec.ts.
@Controller('vendors')
@UseGuards(SessionAuthGuard)
export class VendorsController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auditLog: AuditLogService,
    private readonly idempotencyCompletion: IdempotencyCompletionService,
    private readonly otp: OtpService,
  ) {}

  @Post()
  @HttpCode(201)
  @UseInterceptors(IdempotencyInterceptor)
  async apply(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: CreateVendorDto,
    @Req() req: Request,
  ) {
    return this.prisma.$transaction(async (tx) => {
      // Sprint 7 (RB-STOREF-001): the id is generated up front so the
      // slug can be derived from it deterministically before insert -
      // see common/slug.util.ts. displayName defaults to legalName;
      // the owner may diverge it later via the storefront settings
      // endpoint without ever changing the stable slug.
      const vendorId = randomUUID();
      const created = await tx.vendor.create({
        data: {
          id: vendorId,
          legalName: dto.legal_name,
          slug: generateVendorSlug(dto.legal_name, vendorId),
          displayName: dto.legal_name,
        },
      });
      await tx.vendorUser.create({
        data: { userId: user.id, vendorId: created.id, role: 'OWNER' },
      });
      // Sprint 8 round 2 review fix (RB-STOREF-004, PDR-013): the
      // approved product decision requires applicable_categories at
      // REGISTRATION, not merely before publish - created in the SAME
      // transaction as the vendor row itself, so there is never a
      // moment where a newly-accepted vendor exists with zero
      // categories (unlike a pre-existing/historical vendor, which
      // this migration deliberately never touches - see the owner-only
      // GET/PUT endpoint on StorefrontController for editing this
      // afterward, and the storefront-publish gate that still backstops
      // any vendor, old or new, that somehow reaches publish with none).
      await tx.vendorApplicableCategory.createMany({
        data: dto.applicable_categories.map((category) => ({
          vendorId: created.id,
          category,
        })),
      });
      // Sprint 3 review round 4: createMany() only returns a row count,
      // not the created rows - the response body (which must include
      // each branch's id) can't be built from it without a *separate*,
      // post-transaction findMany(), which is exactly what left this
      // endpoint unable to call IdempotencyCompletionService.complete()
      // from inside the transaction. Individual create() calls give
      // back each row, so the full response can be assembled - and the
      // completion recorded - before the transaction ever commits.
      const branches = await Promise.all(
        dto.branches.map((branch) =>
          tx.storeBranch.create({
            data: {
              vendorId: created.id,
              name: branch.name,
              isPhysical: branch.is_physical,
              lat: branch.lat,
              lng: branch.lng,
            },
          }),
        ),
      );
      await this.auditLog.record(
        {
          actorId: user.id,
          correlationId: req.correlationId,
          action: 'vendor.applied',
          entityType: 'Vendor',
          entityId: created.id,
          afterState: { legalName: created.legalName, status: created.status },
        },
        tx,
      );

      const body = {
        id: created.id,
        legal_name: created.legalName,
        status: created.status,
        branches: branches.map((b) => ({
          id: b.id,
          name: b.name,
          is_physical: b.isPhysical,
          lat: b.lat,
          lng: b.lng,
        })),
        applicable_categories: dto.applicable_categories,
      };
      await this.idempotencyCompletion.complete(
        tx,
        req.idempotencyClaimId,
        body,
        201,
      );
      return body;
    });
  }

  // Sprint 4 (RB-ROLE-004, PDR-009): the first real, testable
  // application of VendorMembershipGuard's branch-scoping - an OWNER
  // sees every branch under their vendor; a BRANCH_EMPLOYEE sees only
  // their own assigned branch, never a sibling branch of the same
  // vendor. No :branchId param on this route, so the guard only checks
  // plain membership here; the employee-scoping is this handler's own
  // job below (mirrors how the guard is documented to work).
  @Get(':vendorId/branches')
  @UseGuards(VendorMembershipGuard)
  async listBranches(
    @Param('vendorId') vendorId: string,
    @CurrentVendorMembership() membership: VendorMembership,
  ) {
    const branches = await this.prisma.storeBranch.findMany({
      where: {
        vendorId,
        ...(membership.role === 'BRANCH_EMPLOYEE'
          ? { id: membership.branchId! }
          : {}),
      },
      orderBy: { createdAt: 'asc' },
    });
    return branches.map(branchSummaryDto);
  }

  // Same guard, but this route *does* have a :branchId param, so
  // VendorMembershipGuard itself already refuses a BRANCH_EMPLOYEE
  // whose own branchId doesn't match it - see the guard's own doc
  // comment. Nothing else to check here beyond that.
  @Get(':vendorId/branches/:branchId')
  @UseGuards(VendorMembershipGuard)
  async getBranch(
    @Param('vendorId') vendorId: string,
    @Param('branchId') branchId: string,
  ) {
    const branch = await this.prisma.storeBranch.findUnique({
      where: { id: branchId },
    });
    if (!branch || branch.vendorId !== vendorId) {
      throw new NotFoundException({
        code: 'BRANCH_NOT_FOUND',
        message: 'Branch not found for this vendor',
      });
    }
    return branchSummaryDto(branch);
  }

  // Sprint 4 (RB-ROLE-002, PDR-008/009): owner-only ("staff" is store
  // configuration - PDR-009 explicitly lists it among what an employee
  // may never touch). Creates the StaffInvite record and issues the
  // OTP in the same transaction/flow as every other "prove phone
  // ownership" step this codebase has (AuthController.requestOtp's
  // STAFF_INVITE branch is what actually sends it, gated on this row
  // existing - see that method's comment).
  @Post(':vendorId/branches/:branchId/staff-invites')
  @HttpCode(201)
  @UseGuards(VendorMembershipGuard)
  @RequireVendorRole('OWNER')
  @UseInterceptors(IdempotencyInterceptor)
  async inviteStaff(
    @Param('vendorId') vendorId: string,
    @Param('branchId') branchId: string,
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: InviteStaffDto,
    @Req() req: Request,
  ) {
    const branch = await this.prisma.storeBranch.findUnique({
      where: { id: branchId },
    });
    if (!branch || branch.vendorId !== vendorId) {
      throw new NotFoundException({
        code: 'BRANCH_NOT_FOUND',
        message: 'Branch not found for this vendor',
      });
    }

    // Fast, friendly, non-authoritative fail-fast for the common case -
    // avoids starting a transaction/lock at all for a request that's
    // obviously going to be rejected. Not load-bearing for correctness
    // on its own; see the fresh re-checks under the advisory lock
    // below, which are what actually close every race this method's
    // own review-round comments describe.
    const existingMember = await this.prisma.vendorUser.findFirst({
      where: { vendorId, user: { phone: dto.phone } },
    });
    if (existingMember) {
      throw new ForbiddenException({
        code: 'ALREADY_VENDOR_MEMBER',
        message:
          'This phone number already belongs to a member of this vendor account',
      });
    }
    // Review-round finding (round 4): PDR-008/SRS Part 3 G.0 - a
    // BRANCH_EMPLOYEE is assigned to one branch *at a time*, across
    // every vendor, not just within this one. Distinct from
    // ALREADY_VENDOR_MEMBER above, which only covers *this* vendor;
    // this covers the phone already being staff *anywhere else*.
    const existingEmployeeElsewhere = await this.prisma.vendorUser.findFirst({
      where: { role: 'BRANCH_EMPLOYEE', user: { phone: dto.phone } },
    });
    if (existingEmployeeElsewhere) {
      throw new ForbiddenException({
        code: 'EMPLOYEE_ALREADY_ASSIGNED',
        message:
          'This phone number is already assigned as a branch employee elsewhere - reassignment is not supported yet',
      });
    }
    // Global, not vendor-scoped (round 4): acceptStaffInvite() has no
    // invite_id parameter and resolves "the" invite for a phone by a
    // plain most-recent-PENDING lookup - two PENDING invites for the
    // same phone from different vendors would make that ambiguous.
    const existingPending = await this.prisma.staffInvite.findFirst({
      where: { phone: dto.phone, status: 'PENDING' },
    });
    if (existingPending) {
      throw new ConflictException({
        code: 'STAFF_INVITE_ALREADY_PENDING',
        message: 'This phone number already has a pending staff invite',
      });
    }

    let body;
    try {
      body = await this.prisma.$transaction(async (tx) => {
        // Review-round finding (round 3, widened in round 4): a
        // Postgres advisory lock keyed by the phone number itself -
        // not a row lock on this one vendor - so it serializes against
        // *every* concurrent inviteStaff()/acceptStaffInvite() call for
        // this exact phone, regardless of which vendor(s) are
        // involved. A vendor-row lock (this method's round-3 version)
        // only closed the race within a single vendor; PDR-008's
        // cross-vendor employee-uniqueness invariant (added round 4)
        // needs the wider key, since two concurrent inviteStaff() calls
        // for two *different* vendors would otherwise never contend on
        // the same row at all and could both pass their pre-checks
        // before either commits. $executeRaw, not $queryRaw:
        // pg_advisory_xact_lock() returns void, which $queryRaw can't
        // deserialize (see categories.controller.ts for the same
        // pattern/note).
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('finalpro:staff_invite:' || ${dto.phone}))`;

        const freshMember = await tx.vendorUser.findFirst({
          where: { vendorId, user: { phone: dto.phone } },
        });
        if (freshMember) {
          throw new ForbiddenException({
            code: 'ALREADY_VENDOR_MEMBER',
            message:
              'This phone number already belongs to a member of this vendor account',
          });
        }
        const freshEmployeeElsewhere = await tx.vendorUser.findFirst({
          where: { role: 'BRANCH_EMPLOYEE', user: { phone: dto.phone } },
        });
        if (freshEmployeeElsewhere) {
          throw new ForbiddenException({
            code: 'EMPLOYEE_ALREADY_ASSIGNED',
            message:
              'This phone number is already assigned as a branch employee elsewhere - reassignment is not supported yet',
          });
        }
        const freshPending = await tx.staffInvite.findFirst({
          where: { phone: dto.phone, status: 'PENDING' },
        });
        if (freshPending) {
          throw new ConflictException({
            code: 'STAFF_INVITE_ALREADY_PENDING',
            message: 'This phone number already has a pending staff invite',
          });
        }

        const invite = await tx.staffInvite.create({
          data: {
            vendorId,
            branchId,
            phone: dto.phone,
            invitedById: user.id,
            expiresAt: new Date(Date.now() + STAFF_INVITE_TTL_MS),
          },
        });
        await this.auditLog.record(
          {
            actorId: user.id,
            correlationId: req.correlationId,
            action: 'staff_invite.created',
            entityType: 'StaffInvite',
            entityId: invite.id,
            afterState: {
              vendor_id: vendorId,
              branch_id: branchId,
              phone: dto.phone,
            },
          },
          tx,
        );

        const responseBody = {
          id: invite.id,
          vendor_id: vendorId,
          branch_id: branchId,
          phone: invite.phone,
          status: invite.status,
          expires_at: invite.expiresAt.toISOString(),
        };
        await this.idempotencyCompletion.complete(
          tx,
          req.idempotencyClaimId,
          responseBody,
          201,
        );
        return responseBody;
      });
    } catch (err) {
      if (
        err instanceof Prisma.PrismaClientKnownRequestError &&
        err.code === 'P2002'
      ) {
        throw new ConflictException({
          code: 'STAFF_INVITE_ALREADY_PENDING',
          message: 'This phone number already has a pending staff invite',
        });
      }
      throw err;
    }

    // Issued after the transaction commits - OtpService.issue() writes
    // through the top-level PrismaService, not this method's `tx`, so it
    // can never be part of that same atomic write anyway; the invite
    // row (already durably committed above) is the real source of
    // truth regardless of whether this SMS send succeeds. If it's lost
    // (a transient SMS-provider failure), the invitee's own client can
    // still recover by calling POST /auth/otp/request itself -
    // AuthController.requestOtp()'s STAFF_INVITE branch re-issues for
    // any phone with a real pending invite, not just the first send.
    await this.otp.issue(dto.phone, 'STAFF_INVITE');

    return body;
  }

  // Sprint 5 (RB-STORE-001, PDR-010): any member may read - store type
  // is not on PDR-009's employee-forbidden list (unlike writing it,
  // below), and other Sprint 5 endpoints/tests need a simple way to
  // confirm the current value. vendorSummaryDto() never includes
  // Warehouse - see its own comment.
  @Get(':vendorId')
  @UseGuards(VendorMembershipGuard)
  async getVendor(@Param('vendorId') vendorId: string) {
    const vendor = await this.prisma.vendor.findUnique({
      where: { id: vendorId },
    });
    if (!vendor) {
      throw new NotFoundException({
        code: 'VENDOR_NOT_FOUND',
        message: 'Vendor not found',
      });
    }
    return vendorSummaryDto(vendor);
  }

  // PDR-010/PDR-009: store type is store configuration - owner-only,
  // same as every other store-configuration write in this controller.
  // Naturally idempotent (a PUT of the same value twice is a no-op), so
  // unlike the POST endpoints above this does not need
  // IdempotencyInterceptor - matches CategoriesController's PATCH,
  // the only other pre-existing non-POST mutating endpoint in this
  // codebase.
  @Put(':vendorId/store-type')
  @UseGuards(VendorMembershipGuard)
  @RequireVendorRole('OWNER')
  async updateStoreType(
    @Param('vendorId') vendorId: string,
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: UpdateStoreTypeDto,
    @Req() req: Request,
  ) {
    const vendor = await this.prisma.vendor.findUnique({
      where: { id: vendorId },
    });
    if (!vendor) {
      throw new NotFoundException({
        code: 'VENDOR_NOT_FOUND',
        message: 'Vendor not found',
      });
    }

    const updated = await this.prisma.vendor.update({
      where: { id: vendorId },
      data: { storeType: dto.store_type },
    });
    await this.auditLog.record({
      actorId: user.id,
      correlationId: req.correlationId,
      action: 'vendor.store_type_updated',
      entityType: 'Vendor',
      entityId: vendorId,
      beforeState: { store_type: vendor.storeType },
      afterState: { store_type: updated.storeType },
    });
    return vendorSummaryDto(updated);
  }

  // Sprint 5 review-round fix (RB-STORE-001, PDR-010): "hidden" means
  // hidden from customers, from a BRANCH_EMPLOYEE, and from anyone who
  // isn't a member at all - it does NOT mean the OWNER can't read back
  // an operational setting they themselves configured. The original
  // version of this endpoint only ever returned a minimal ack with no
  // way to reload the address afterwards, which would have made the
  // warehouse effectively write-only for the one person who is
  // supposed to manage it. Fixed by adding an explicit owner-only GET
  // below; this PUT's own response stays the same minimal ack (that
  // part was never the problem, and the caller who just sent the
  // values doesn't need them echoed back).
  //
  // Deliberately requires storeType to already be ONLINE_ONLY/HYBRID: a
  // warehouse is meaningless for a purely physical store, and this
  // keeps the two fields from silently drifting out of sync.
  @Put(':vendorId/warehouse')
  @UseGuards(VendorMembershipGuard)
  @RequireVendorRole('OWNER')
  async upsertWarehouse(
    @Param('vendorId') vendorId: string,
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: UpsertWarehouseDto,
    @Req() req: Request,
  ) {
    const vendor = await this.prisma.vendor.findUnique({
      where: { id: vendorId },
    });
    if (!vendor) {
      throw new NotFoundException({
        code: 'VENDOR_NOT_FOUND',
        message: 'Vendor not found',
      });
    }
    if (vendor.storeType === 'PHYSICAL') {
      throw new BadRequestException({
        code: 'STORE_NOT_ONLINE_CAPABLE',
        message:
          'Set store_type to online_only or hybrid before configuring a warehouse',
      });
    }

    const warehouse = await this.prisma.warehouse.upsert({
      where: { vendorId },
      create: {
        vendorId,
        lat: dto.lat,
        lng: dto.lng,
        addressNote: dto.address_note,
      },
      update: {
        lat: dto.lat,
        lng: dto.lng,
        addressNote: dto.address_note,
      },
    });
    await this.auditLog.record({
      actorId: user.id,
      correlationId: req.correlationId,
      action: 'vendor.warehouse_upserted',
      entityType: 'Warehouse',
      entityId: warehouse.id,
      afterState: { vendor_id: vendorId },
    });
    // Deliberately does NOT echo lat/lng/addressNote back - not a
    // privacy measure (see getWarehouse below, which does return them
    // to the owner), just an unnecessary round-trip: the caller who
    // just sent these values doesn't need them read back in the same
    // response.
    return { id: warehouse.id, vendor_id: warehouse.vendorId };
  }

  // Sprint 5 review-round fix: the owner-only read path upsertWarehouse's
  // own comment refers to - returns the real address fields so a
  // reopened dashboard can actually load what was previously set.
  // VendorMembershipGuard + @RequireVendorRole('OWNER') reject a
  // BRANCH_EMPLOYEE (VENDOR_ROLE_FORBIDDEN) and a non-member
  // (NOT_VENDOR_MEMBER) the same way every other owner-only route here
  // does; this is never wired into vendorSummaryDto() or any other
  // public/general-membership endpoint.
  @Get(':vendorId/warehouse')
  @UseGuards(VendorMembershipGuard)
  @RequireVendorRole('OWNER')
  async getWarehouse(@Param('vendorId') vendorId: string) {
    const warehouse = await this.prisma.warehouse.findUnique({
      where: { vendorId },
    });
    if (!warehouse) {
      throw new NotFoundException({
        code: 'WAREHOUSE_NOT_FOUND',
        message: 'This vendor has not configured a warehouse yet',
      });
    }
    return warehouseDto(warehouse);
  }

  @Post(':vendorId/pickup-points')
  @HttpCode(201)
  @UseGuards(VendorMembershipGuard)
  @RequireVendorRole('OWNER')
  @UseInterceptors(IdempotencyInterceptor)
  async createPickupPoint(
    @Param('vendorId') vendorId: string,
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: CreatePickupPointDto,
    @Req() req: Request,
  ) {
    return this.prisma.$transaction(async (tx) => {
      const point = await tx.pickupPoint.create({
        data: {
          vendorId,
          name: dto.name,
          lat: dto.lat,
          lng: dto.lng,
          addressNote: dto.address_note,
        },
      });
      await this.auditLog.record(
        {
          actorId: user.id,
          correlationId: req.correlationId,
          action: 'pickup_point.created',
          entityType: 'PickupPoint',
          entityId: point.id,
          afterState: pickupPointDto(point),
        },
        tx,
      );

      const body = pickupPointDto(point);
      await this.idempotencyCompletion.complete(
        tx,
        req.idempotencyClaimId,
        body,
        201,
      );
      return body;
    });
  }

  // Any member may list/read - not on PDR-009's employee-forbidden list
  // (only creating/managing store configuration is owner-only). No
  // public/unauthenticated read path exists yet - RB-STORE-001 is the
  // data model plus owner-facing CRUD; the customer-facing pickup
  // *workflow* (public listing, slot booking) is explicitly out of
  // Sprint 5 scope.
  @Get(':vendorId/pickup-points')
  @UseGuards(VendorMembershipGuard)
  async listPickupPoints(@Param('vendorId') vendorId: string) {
    const points = await this.prisma.pickupPoint.findMany({
      where: { vendorId },
      orderBy: { createdAt: 'asc' },
    });
    return points.map(pickupPointDto);
  }

  @Get(':vendorId/pickup-points/:pickupPointId')
  @UseGuards(VendorMembershipGuard)
  async getPickupPoint(
    @Param('vendorId') vendorId: string,
    @Param('pickupPointId') pickupPointId: string,
  ) {
    const point = await this.prisma.pickupPoint.findUnique({
      where: { id: pickupPointId },
    });
    if (!point || point.vendorId !== vendorId) {
      throw new NotFoundException({
        code: 'PICKUP_POINT_NOT_FOUND',
        message: 'Pickup point not found for this vendor',
      });
    }
    return pickupPointDto(point);
  }

  // Sprint 5 (RB-STORE-002, PDR-022): any member may read. A region
  // with no row is reported enabled=true - see VendorDeliveryZone's
  // schema comment for the lazy-default convention this follows.
  @Get(':vendorId/delivery-zones')
  @UseGuards(VendorMembershipGuard)
  async listDeliveryZones(@Param('vendorId') vendorId: string) {
    const rows = await this.prisma.vendorDeliveryZone.findMany({
      where: { vendorId },
    });
    const byRegion = new Map(rows.map((r) => [r.region, r.enabled]));
    return ALL_DELIVERY_ZONE_REGIONS.map((region) => ({
      region,
      enabled: byRegion.get(region) ?? true,
    }));
  }

  // Owner-only write (store-wide delivery configuration, PDR-009).
  // Naturally idempotent (see updateStoreType's own note) - no
  // IdempotencyInterceptor needed.
  @Put(':vendorId/delivery-zones/:region')
  @UseGuards(VendorMembershipGuard)
  @RequireVendorRole('OWNER')
  async updateDeliveryZone(
    @Param('vendorId') vendorId: string,
    @Param('region') region: string,
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: UpdateDeliveryZoneDto,
    @Req() req: Request,
  ) {
    if (!ALL_DELIVERY_ZONE_REGIONS.includes(region as DeliveryZoneRegion)) {
      throw new BadRequestException({
        code: 'INVALID_DELIVERY_ZONE_REGION',
        message: `region must be one of ${ALL_DELIVERY_ZONE_REGIONS.join(', ')}`,
      });
    }
    const typedRegion = region as DeliveryZoneRegion;

    const zone = await this.prisma.vendorDeliveryZone.upsert({
      where: { vendorId_region: { vendorId, region: typedRegion } },
      create: { vendorId, region: typedRegion, enabled: dto.enabled },
      update: { enabled: dto.enabled },
    });
    await this.auditLog.record({
      actorId: user.id,
      correlationId: req.correlationId,
      action: 'vendor_delivery_zone.updated',
      entityType: 'VendorDeliveryZone',
      entityId: zone.id,
      afterState: { region: zone.region, enabled: zone.enabled },
    });
    return { region: zone.region, enabled: zone.enabled };
  }
}
