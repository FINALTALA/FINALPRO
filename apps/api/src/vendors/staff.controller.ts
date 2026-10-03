import {
  Body,
  ConflictException,
  Controller,
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
import {
  AuthenticatedUser,
  SessionAuthGuard,
} from '../auth/session-auth.guard';
import { VendorMembershipGuard } from '../auth/vendor-membership.guard';
import { RequireVendorRole } from '../auth/vendor-role.decorator';
import { lockBranchOperationalStatus } from '../common/branch-operational-lock.util';
import { IdempotencyCompletionService } from '../common/idempotency/idempotency-completion.service';
import { IdempotencyInterceptor } from '../common/idempotency/idempotency.interceptor';
import { PrismaService } from '../prisma/prisma.service';
import { TransferStaffDto } from './dto/transfer-staff.dto';

function staffDto(vendorUser: {
  id: string;
  branchId: string | null;
  branch: { name: string } | null;
  status: string;
  user: { phone: string };
}) {
  return {
    id: vendorUser.id,
    phone: vendorUser.user.phone,
    branch_id: vendorUser.branchId,
    branch_name: vendorUser.branch?.name ?? null,
    status: vendorUser.status,
  };
}

// Sprint 18b (G-IN-05, SRS-H3A-03): the actual accepted-staff roster
// (VendorUser rows), distinct from GET :vendorId/staff-invites (which
// only ever lists invites, not members). BRANCH_EMPLOYEE only - an
// OWNER is never listed here (G-IN-05's own scope: "list/transfer/
// suspend the vendor's employees", not vendor ownership itself). No
// @BlockWhenSuspended - "staff" is the established ALLOW category for
// a suspended vendor.
@Controller('vendors/:vendorId/staff')
@UseGuards(SessionAuthGuard, VendorMembershipGuard)
@RequireVendorRole('OWNER')
export class StaffController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auditLog: AuditLogService,
    private readonly idempotencyCompletion: IdempotencyCompletionService,
  ) {}

  @Get()
  async listStaff(@Param('vendorId') vendorId: string) {
    const rows = await this.prisma.vendorUser.findMany({
      where: { vendorId, role: 'BRANCH_EMPLOYEE' },
      include: {
        branch: { select: { name: true } },
        user: { select: { phone: true } },
      },
      orderBy: { id: 'asc' },
    });
    return rows.map(staffDto);
  }

  // Sprint 18b (RB-ROLE-003): moving branchId on the SAME VendorUser
  // row - never a new row (the partial unique index on BRANCH_EMPLOYEE
  // already relies on this being an UPDATE, not an INSERT). Lock
  // order: branch-operational-status advisory lock on the TARGET
  // branch first, then this VendorUser row - the global fixed order
  // (branch-operational-lock.util.ts) - so no operation anywhere in
  // this codebase that takes both ever does so in the reverse order.
  @Post(':vendorUserId/transfer')
  @HttpCode(200)
  @UseInterceptors(IdempotencyInterceptor)
  async transfer(
    @Param('vendorId') vendorId: string,
    @Param('vendorUserId') vendorUserId: string,
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: TransferStaffDto,
    @Req() req: Request,
  ) {
    const body = await this.prisma.$transaction(async (tx) => {
      await lockBranchOperationalStatus(tx, vendorId, dto.branch_id);

      const targetBranch = await tx.storeBranch.findUnique({
        where: { id: dto.branch_id },
      });
      if (!targetBranch || targetBranch.vendorId !== vendorId) {
        throw new NotFoundException({
          code: 'BRANCH_NOT_FOUND',
          message: 'Target branch not found for this vendor',
        });
      }
      if (
        targetBranch.verificationStatus !== 'APPROVED' ||
        targetBranch.archivedAt !== null
      ) {
        throw new ConflictException({
          code: 'BRANCH_NOT_AVAILABLE_FOR_STAFF',
          message:
            'The target branch is not approved or is archived - staff cannot be transferred to it',
        });
      }
      // A temporary closure does NOT block a transfer, deliberately -
      // only unapproved/archived do (product decision).

      await tx.$queryRaw`SELECT id FROM vendor_users WHERE id = ${vendorUserId} FOR UPDATE`;
      const employee = await tx.vendorUser.findUniqueOrThrow({
        where: { id: vendorUserId },
        include: { user: { select: { phone: true } } },
      });
      if (
        employee.vendorId !== vendorId ||
        employee.role !== 'BRANCH_EMPLOYEE'
      ) {
        throw new NotFoundException({
          code: 'STAFF_MEMBER_NOT_FOUND',
          message: 'No branch employee with this id was found for this vendor',
        });
      }

      const beforeBranchId = employee.branchId;
      const updated = await tx.vendorUser.update({
        where: { id: vendorUserId },
        data: { branchId: dto.branch_id },
        include: {
          branch: { select: { name: true } },
          user: { select: { phone: true } },
        },
      });
      await this.auditLog.record(
        {
          actorId: user.id,
          correlationId: req.correlationId,
          action: 'vendor_user.transferred',
          entityType: 'VendorUser',
          entityId: vendorUserId,
          beforeState: { branch_id: beforeBranchId },
          afterState: { branch_id: dto.branch_id },
        },
        tx,
      );
      const responseBody = staffDto(updated);
      await this.idempotencyCompletion.complete(
        tx,
        req.idempotencyClaimId,
        responseBody,
        200,
      );
      return responseBody;
    });
    return body;
  }

  @Post(':vendorUserId/suspend')
  @HttpCode(200)
  @UseInterceptors(IdempotencyInterceptor)
  async suspend(
    @Param('vendorId') vendorId: string,
    @Param('vendorUserId') vendorUserId: string,
    @CurrentUser() user: AuthenticatedUser,
    @Req() req: Request,
  ) {
    return this.setStatus(vendorId, vendorUserId, 'SUSPENDED', user, req);
  }

  @Post(':vendorUserId/reactivate')
  @HttpCode(200)
  @UseInterceptors(IdempotencyInterceptor)
  async reactivate(
    @Param('vendorId') vendorId: string,
    @Param('vendorUserId') vendorUserId: string,
    @CurrentUser() user: AuthenticatedUser,
    @Req() req: Request,
  ) {
    return this.setStatus(vendorId, vendorUserId, 'ACTIVE', user, req);
  }

  // Shared by suspend/reactivate - only a VendorUser row lock is
  // needed (no branch involved at all), the global fixed order's last
  // step. Re-checks role=BRANCH_EMPLOYEE fresh under the lock - an
  // OWNER row can never be suspended through this endpoint (and the
  // DB's own CHECK constraint makes it impossible regardless).
  private async setStatus(
    vendorId: string,
    vendorUserId: string,
    status: 'ACTIVE' | 'SUSPENDED',
    user: AuthenticatedUser,
    req: Request,
  ) {
    const body = await this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM vendor_users WHERE id = ${vendorUserId} FOR UPDATE`;
      const employee = await tx.vendorUser.findUniqueOrThrow({
        where: { id: vendorUserId },
      });
      if (
        employee.vendorId !== vendorId ||
        employee.role !== 'BRANCH_EMPLOYEE'
      ) {
        throw new NotFoundException({
          code: 'STAFF_MEMBER_NOT_FOUND',
          message: 'No branch employee with this id was found for this vendor',
        });
      }

      const updated = await tx.vendorUser.update({
        where: { id: vendorUserId },
        data: { status },
        include: {
          branch: { select: { name: true } },
          user: { select: { phone: true } },
        },
      });
      await this.auditLog.record(
        {
          actorId: user.id,
          correlationId: req.correlationId,
          action:
            status === 'SUSPENDED'
              ? 'vendor_user.suspended'
              : 'vendor_user.reactivated',
          entityType: 'VendorUser',
          entityId: vendorUserId,
          beforeState: { status: employee.status },
          afterState: { status },
        },
        tx,
      );
      const responseBody = staffDto(updated);
      await this.idempotencyCompletion.complete(
        tx,
        req.idempotencyClaimId,
        responseBody,
        200,
      );
      return responseBody;
    });
    return body;
  }
}
