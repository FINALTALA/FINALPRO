import {
  Body,
  Controller,
  Get,
  Param,
  Put,
  Req,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { ConflictException } from '@nestjs/common';
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
import { ReturnPolicyInputDto } from '../returns/dto/return-policy-input.dto';

// Same "N months = N*30 days, fixed milliseconds" approximation this
// codebase already established for SubscriptionGateService's own
// SANDBOX_PERIOD_DAYS - not real calendar-month arithmetic.
const RETURN_POLICY_MIN_CHANGE_INTERVAL_DAYS = 180;
const RETURN_POLICY_MIN_CHANGE_INTERVAL_MS =
  RETURN_POLICY_MIN_CHANGE_INTERVAL_DAYS * 24 * 60 * 60 * 1000;

function policyDto(vendor: {
  returnsEnabled: boolean;
  returnMode: string;
  returnWindowDays: number | null;
  returnFeeIls: unknown;
  returnPolicyUpdatedAt: Date | null;
}) {
  return {
    mode: vendor.returnMode,
    window_days: vendor.returnWindowDays,
    fee_ils: vendor.returnFeeIls != null ? Number(vendor.returnFeeIls) : null,
    updated_at: vendor.returnPolicyUpdatedAt,
  };
}

// Sprint 21 (PDR-030): the LATER-update half of the return policy -
// the INITIAL selection happens at POST /vendors itself
// (CreateVendorDto.return_policy), never left null until an owner
// visits this page. "Policy/fees change at most once per six months"
// taken literally: the Vendor row is locked (FOR UPDATE, it always
// exists - no "row doesn't exist yet" case the way a never-touched
// VendorDeliveryZone has), returnPolicyUpdatedAt re-read under that
// lock, and the write rejected with 409 if less than 6 months have
// passed - closing the exact race two concurrent updates could
// otherwise exploit (both reading a stale timestamp, both passing).
// A legacy vendor (returnPolicyUpdatedAt still null, pre-dates this
// feature) is never gated on its first post-migration write.
@Controller('vendors/:vendorId/return-policy')
@UseGuards(SessionAuthGuard, VendorMembershipGuard)
export class ReturnPolicyController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auditLog: AuditLogService,
  ) {}

  @Get()
  async get(@Param('vendorId') vendorId: string) {
    const vendor = await this.prisma.vendor.findUniqueOrThrow({
      where: { id: vendorId },
    });
    return policyDto(vendor);
  }

  @Put()
  @RequireVendorRole('OWNER')
  @UseInterceptors(IdempotencyInterceptor)
  async update(
    @Param('vendorId') vendorId: string,
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: ReturnPolicyInputDto,
    @Req() req: Request,
  ) {
    return this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM vendors WHERE id = ${vendorId} FOR UPDATE`;
      const vendor = await tx.vendor.findUniqueOrThrow({
        where: { id: vendorId },
      });
      const now = new Date();
      if (vendor.returnPolicyUpdatedAt !== null) {
        const elapsedMs =
          now.getTime() - vendor.returnPolicyUpdatedAt.getTime();
        if (elapsedMs < RETURN_POLICY_MIN_CHANGE_INTERVAL_MS) {
          throw new ConflictException({
            code: 'RETURN_POLICY_CHANGE_TOO_SOON',
            message:
              'The return policy can change at most once every six months',
          });
        }
      }

      const before = policyDto(vendor);
      const updated = await tx.vendor.update({
        where: { id: vendorId },
        data: {
          returnsEnabled: dto.mode === 'REFUND_ONLY',
          returnMode: dto.mode,
          returnWindowDays:
            dto.mode === 'REFUND_ONLY' ? dto.window_days! : null,
          returnFeeIls: dto.mode === 'REFUND_ONLY' ? dto.fee_ils! : null,
          returnPolicyUpdatedAt: now,
        },
      });
      await this.auditLog.record(
        {
          actorId: user.id,
          correlationId: req.correlationId,
          action: 'vendor.return_policy_updated',
          entityType: 'Vendor',
          entityId: vendorId,
          beforeState: before,
          afterState: policyDto(updated),
        },
        tx,
      );
      return policyDto(updated);
    });
  }
}
