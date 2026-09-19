import {
  Body,
  ConflictException,
  Controller,
  ForbiddenException,
  Get,
  HttpCode,
  NotFoundException,
  Param,
  Post,
  Req,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
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
import { Prisma } from '../../generated/prisma/client';
import { IdempotencyCompletionService } from '../common/idempotency/idempotency-completion.service';
import { IdempotencyInterceptor } from '../common/idempotency/idempotency.interceptor';
import { PrismaService } from '../prisma/prisma.service';
import { CreateVendorDto } from './dto/create-vendor.dto';
import { InviteStaffDto } from './dto/invite-staff.dto';

const STAFF_INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

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
      const created = await tx.vendor.create({
        data: { legalName: dto.legal_name },
      });
      await tx.vendorUser.create({
        data: { userId: user.id, vendorId: created.id, role: 'OWNER' },
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

    // Review-round finding: a plain pre-check here (findFirst then
    // create, two separate statements) is only a fast, friendly
    // rejection for the common case - it cannot by itself prevent two
    // concurrent invites for the same (vendorId, phone) racing each
    // other, since both could pass this check before either commits.
    // The `staff_invites_vendor_phone_pending_key` partial unique index
    // (this sprint's own migration) is what actually closes that race
    // atomically at the database layer; the catch block below is what
    // turns *that* into the same clean 409 for whichever request loses
    // it, so a concurrent caller sees a consistent error either way.
    const existingPending = await this.prisma.staffInvite.findFirst({
      where: { vendorId, phone: dto.phone, status: 'PENDING' },
    });
    if (existingPending) {
      throw new ConflictException({
        code: 'STAFF_INVITE_ALREADY_PENDING',
        message:
          'This phone number already has a pending invite for this vendor account',
      });
    }

    let body;
    try {
      body = await this.prisma.$transaction(async (tx) => {
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
          message:
            'This phone number already has a pending invite for this vendor account',
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
}
