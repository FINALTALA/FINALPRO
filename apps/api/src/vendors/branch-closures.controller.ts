import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  Get,
  HttpCode,
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
import {
  activeOrdersDetails,
  activeOrdersInSpan,
  lockBranchWindowRows,
} from '../delivery-windows/delivery-window-rules';
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
import {
  CancelBranchClosureDto,
  ShortenBranchClosureDto,
} from './dto/change-branch-closure.dto';
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

function closureNotFound() {
  return new NotFoundException({
    code: 'BRANCH_CLOSURE_NOT_FOUND',
    message: 'Closure not found for this branch',
  });
}

function closureEnded() {
  return new ConflictException({
    code: 'BRANCH_CLOSURE_ENDED',
    message: 'This closure has ended - past closures are never edited',
  });
}

function isExclusionViolation(err: unknown, constraintName: string): boolean {
  return (
    err instanceof Prisma.PrismaClientKnownRequestError &&
    err.code === 'P2039' &&
    err.message.includes(constraintName)
  );
}

// Sprint 18b (G-ON-07, FR-VEND-006) + «ساعات العمل والإغلاقات v1»: the past
// is never edited. A FUTURE closure may be cancelled; a closure may be
// shortened (a started one only from now on - its past effect stays);
// an ended closure is never touched. Both need a reason and are audited
// (before/after, actor). There is still no PUT/DELETE. [startsAt, endsAt) is genuinely half-open -
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

        // «نوافذ التوصيل v1»: a planned closure is never placed on top of
        // active delivery orders (same rule as closing a day). The branch's
        // window rows are locked first - the locks reserve()/confirm() take
        // on a slot - so no booking lands in the closure meanwhile.
        await lockBranchWindowRows(tx, vendorId, branchId);
        const covered = await activeOrdersInSpan(
          tx,
          vendorId,
          branchId,
          startsAt,
          endsAt,
        );
        if (covered.length > 0) {
          throw new ConflictException({
            code: 'BRANCH_CLOSURE_HAS_ACTIVE_ORDERS',
            message: `This closure covers ${covered.length} active delivery order(s) - choose other times, or handle the orders first.`,
            details: [activeOrdersDetails(covered)],
          });
        }

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

  /** Locks the branch, then the closure row; 404 unless it is this branch's. */
  private async lockClosure(
    tx: Prisma.TransactionClient,
    vendorId: string,
    branchId: string,
    closureId: string,
  ) {
    await lockBranchOperationalStatus(tx, vendorId, branchId);
    if (!isUuidLike(closureId)) throw closureNotFound();
    await tx.$queryRaw`SELECT id FROM branch_closures WHERE id = ${closureId} FOR UPDATE`;
    const closure = await tx.branchClosure.findUnique({
      where: { id: closureId },
    });
    if (
      !closure ||
      closure.vendorId !== vendorId ||
      closure.branchId !== branchId
    ) {
      throw closureNotFound();
    }
    return closure;
  }

  /** Cancel a closure that has not started yet (the row goes; the audit keeps it). */
  @Post(':closureId/cancel')
  @HttpCode(200)
  @RequireVendorRole('OWNER')
  @BlockWhenBranchArchived()
  async cancelClosure(
    @Param('vendorId') vendorId: string,
    @Param('branchId') branchId: string,
    @Param('closureId') closureId: string,
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: CancelBranchClosureDto,
    @Req() req: Request,
  ) {
    await this.requireBranch(vendorId, branchId);
    return this.prisma.$transaction(async (tx) => {
      const closure = await this.lockClosure(tx, vendorId, branchId, closureId);
      const now = new Date();
      if (closure.endsAt <= now) throw closureEnded();
      if (closure.startsAt <= now) {
        throw new ConflictException({
          code: 'BRANCH_CLOSURE_STARTED',
          message:
            'This closure has already started - its past cannot be undone; shorten it to end now instead.',
        });
      }
      await tx.branchClosure.delete({ where: { id: closure.id } });
      await this.auditLog.record(
        {
          actorId: user.id,
          correlationId: req.correlationId,
          action: 'store_branch.closure_cancelled',
          entityType: 'BranchClosure',
          entityId: closure.id,
          beforeState: closureDto(closure),
          afterState: { cancelled: true, change_reason: dto.reason },
        },
        tx,
      );
      return { ...closureDto(closure), cancelled: true };
    });
  }

  /** Shorten a closure: a new, earlier end (never in the past once started). */
  @Post(':closureId/shorten')
  @HttpCode(200)
  @RequireVendorRole('OWNER')
  @BlockWhenBranchArchived()
  async shortenClosure(
    @Param('vendorId') vendorId: string,
    @Param('branchId') branchId: string,
    @Param('closureId') closureId: string,
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: ShortenBranchClosureDto,
    @Req() req: Request,
  ) {
    await this.requireBranch(vendorId, branchId);
    const endsAt = new Date(dto.ends_at);
    return this.prisma.$transaction(async (tx) => {
      const closure = await this.lockClosure(tx, vendorId, branchId, closureId);
      const now = new Date();
      if (closure.endsAt <= now) throw closureEnded();
      if (endsAt.getTime() <= closure.startsAt.getTime()) {
        throw new BadRequestException({
          code: 'INVALID_CLOSURE_RANGE',
          message:
            'The new end must be after the start (to remove a future closure, cancel it)',
        });
      }
      if (endsAt.getTime() >= closure.endsAt.getTime()) {
        throw new BadRequestException({
          code: 'CLOSURE_NOT_SHORTER',
          message: 'The new end must be earlier than the current end',
        });
      }
      // a started closure is shortened only from now on - one minute of
      // slack for the request's own travel time
      if (endsAt.getTime() < now.getTime() - 60_000) {
        throw new BadRequestException({
          code: 'CLOSURE_END_IN_PAST',
          message: 'A closure cannot be shortened into the past',
        });
      }
      const updated = await tx.branchClosure.update({
        where: { id: closure.id },
        data: {
          endsAt: endsAt.getTime() < now.getTime() ? now : endsAt,
        },
      });
      await this.auditLog.record(
        {
          actorId: user.id,
          correlationId: req.correlationId,
          action: 'store_branch.closure_shortened',
          entityType: 'BranchClosure',
          entityId: closure.id,
          beforeState: closureDto(closure),
          afterState: { ...closureDto(updated), change_reason: dto.reason },
        },
        tx,
      );
      return closureDto(updated);
    });
  }
}
