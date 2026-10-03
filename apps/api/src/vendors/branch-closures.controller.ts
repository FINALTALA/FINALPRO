import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  Get,
  NotFoundException,
  Param,
  Post,
  Query,
  Req,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { Request } from 'express';
import { Prisma } from '../../generated/prisma/client';
import { AuditLogService } from '../audit/audit-log.service';
import { BlockWhenBranchArchived } from '../auth/branch-archived.guard';
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
import {
  decodeCursor,
  encodeCursor,
  isIsoDateString,
  isUuidLike,
  parseLimit,
} from '../platform-admin/cursor.util';
import { PrismaService } from '../prisma/prisma.service';
import { CreateBranchClosureDto } from './dto/create-branch-closure.dto';

function closureDto(closure: {
  id: string;
  branchId: string;
  startsAt: Date;
  endsAt: Date;
  reason: string | null;
  createdBy: string;
  createdAt: Date;
}) {
  return {
    id: closure.id,
    branch_id: closure.branchId,
    starts_at: closure.startsAt.toISOString(),
    ends_at: closure.endsAt.toISOString(),
    reason: closure.reason,
    created_by: closure.createdBy,
    created_at: closure.createdAt.toISOString(),
  };
}

function isExclusionViolation(err: unknown, constraintName: string): boolean {
  return (
    err instanceof Prisma.PrismaClientKnownRequestError &&
    err.code === 'P2039' &&
    err.message.includes(constraintName)
  );
}

// Sprint 18b (G-ON-07, FR-VEND-006): a historical record, never
// edited/deleted - a correction is a new row, not an update, so there
// is no PUT/DELETE here. [startsAt, endsAt) is genuinely half-open -
// see BranchClosure's own schema comment - so two closures that merely
// touch are not an overlap. No @BlockWhenSuspended - "store
// configuration... delivery setup" is the established ALLOW category.
@Controller('vendors/:vendorId/branches/:branchId/closures')
@UseGuards(SessionAuthGuard, VendorMembershipGuard)
export class BranchClosuresController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auditLog: AuditLogService,
    private readonly idempotencyCompletion: IdempotencyCompletionService,
  ) {}

  private async requireBranch(vendorId: string, branchId: string) {
    const branch = await this.prisma.storeBranch.findUnique({
      where: { id: branchId },
    });
    if (!branch || branch.vendorId !== vendorId) {
      throw new NotFoundException({
        code: 'BRANCH_NOT_FOUND',
        message: 'Branch not found for this vendor',
      });
    }
  }

  @Get()
  async listClosures(
    @Param('vendorId') vendorId: string,
    @Param('branchId') branchId: string,
    @Query('cursor') cursorRaw?: string,
    @Query('limit') limitRaw?: string,
  ) {
    await this.requireBranch(vendorId, branchId);
    const limit = parseLimit(limitRaw);
    const cursor = decodeCursor(cursorRaw, [isIsoDateString, isUuidLike]);

    const where: Prisma.BranchClosureWhereInput = { vendorId, branchId };
    if (cursor) {
      const [cursorCreatedAtRaw, cursorId] = cursor as [string, string];
      const cursorCreatedAt = new Date(cursorCreatedAtRaw);
      where.OR = [
        { createdAt: { gt: cursorCreatedAt } },
        { createdAt: cursorCreatedAt, id: { gt: cursorId } },
      ];
    }

    const rows = await this.prisma.branchClosure.findMany({
      where,
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      take: limit + 1,
    });
    const page = rows.slice(0, limit);
    const last = page[page.length - 1];
    return {
      items: page.map(closureDto),
      next_cursor:
        rows.length > limit && last
          ? encodeCursor([last.createdAt.toISOString(), last.id])
          : null,
    };
  }

  @Post()
  @RequireVendorRole('OWNER')
  @BlockWhenBranchArchived()
  @UseInterceptors(IdempotencyInterceptor)
  async createClosure(
    @Param('vendorId') vendorId: string,
    @Param('branchId') branchId: string,
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: CreateBranchClosureDto,
    @Req() req: Request,
  ) {
    await this.requireBranch(vendorId, branchId);
    const startsAt = new Date(dto.starts_at);
    const endsAt = new Date(dto.ends_at);
    if (startsAt.getTime() >= endsAt.getTime()) {
      throw new BadRequestException({
        code: 'INVALID_CLOSURE_RANGE',
        message: 'starts_at must be before ends_at',
      });
    }

    let body;
    try {
      body = await this.prisma.$transaction(async (tx) => {
        // Serializes against reserve()/archive() for this exact
        // branch - closes the race a plain pre-check alone would
        // leave open (see this lock's own comment).
        await lockBranchOperationalStatus(tx, vendorId, branchId);

        const closure = await tx.branchClosure.create({
          data: {
            vendorId,
            branchId,
            startsAt,
            endsAt,
            reason: dto.reason ?? null,
            createdBy: user.id,
          },
        });
        await this.auditLog.record(
          {
            actorId: user.id,
            correlationId: req.correlationId,
            action: 'store_branch.closure_created',
            entityType: 'BranchClosure',
            entityId: closure.id,
            afterState: closureDto(closure),
          },
          tx,
        );
        const responseBody = closureDto(closure);
        await this.idempotencyCompletion.complete(
          tx,
          req.idempotencyClaimId,
          responseBody,
          201,
        );
        return responseBody;
      });
    } catch (err) {
      if (isExclusionViolation(err, 'branch_closures_no_overlap')) {
        throw new ConflictException({
          code: 'BRANCH_CLOSURE_OVERLAPS',
          message: 'This closure overlaps an existing closure for this branch',
        });
      }
      throw err;
    }
    return body;
  }
}
