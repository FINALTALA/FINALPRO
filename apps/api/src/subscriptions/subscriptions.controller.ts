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
import {
  AuthenticatedUser,
  SessionAuthGuard,
} from '../auth/session-auth.guard';
import { IdempotencyInterceptor } from '../common/idempotency/idempotency.interceptor';
import { PrismaService } from '../prisma/prisma.service';
import { SelectSubscriptionPlanDto } from './dto/select-subscription-plan.dto';

const SANDBOX_PERIOD_DAYS = 30;

/**
 * FR-VEND-004 / BR-SUBSCRIPTION - ⚠ OPEN-003 is explicitly still open
 * (Part 9, line 135: "blocks real vendor billing; FYP simulates it
 * regardless"). This is a sandbox flow, the same pattern already used
 * for OPEN-001 (payment) and OPEN-004 (SMS): no real payment is taken,
 * selecting a plan activates it immediately. Real plan pricing tiers
 * and the grace-period length remain undecided - only the
 * Approved -> (plan selected) -> Active transition BL-VEND-004 needs is
 * built here, not the automated Active -> PastDue -> Suspended sweep
 * (needs a scheduled-job worker this codebase doesn't have yet).
 */
@Controller('vendors/:vendorId/subscription')
@UseGuards(SessionAuthGuard)
export class SubscriptionsController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auditLog: AuditLogService,
  ) {}

  private async requireOwner(vendorId: string, userId: string) {
    const membership = await this.prisma.vendorUser.findUnique({
      where: { userId_vendorId: { userId, vendorId } },
    });
    if (!membership) {
      throw new ForbiddenException({
        code: 'NOT_VENDOR_OWNER',
        message: 'You are not a member of this vendor account',
      });
    }
  }

  private toDto(sub: {
    id: string;
    vendorId: string;
    plan: string;
    status: string;
    periodStart: Date;
    periodEnd: Date;
    graceDeadline: Date | null;
  }) {
    return {
      id: sub.id,
      vendor_id: sub.vendorId,
      plan: sub.plan,
      status: sub.status,
      period_start: sub.periodStart.toISOString(),
      period_end: sub.periodEnd.toISOString(),
      grace_deadline: sub.graceDeadline?.toISOString() ?? null,
      simulated: true as const,
    };
  }

  @Get()
  async current(
    @Param('vendorId') vendorId: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    await this.requireOwner(vendorId, user.id);
    const sub = await this.prisma.vendorSubscription.findFirst({
      where: { vendorId },
      orderBy: { createdAt: 'desc' },
    });
    if (!sub) {
      throw new NotFoundException({
        code: 'NO_SUBSCRIPTION',
        message: 'This vendor has not selected a subscription plan yet',
      });
    }
    return this.toDto(sub);
  }

  @Post()
  @HttpCode(201)
  @UseInterceptors(IdempotencyInterceptor)
  async select(
    @Param('vendorId') vendorId: string,
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: SelectSubscriptionPlanDto,
    @Req() req: Request,
  ) {
    await this.requireOwner(vendorId, user.id);

    const { subscription, alreadyActive } = await this.prisma.$transaction(
      async (tx) => {
        // Serializes concurrent plan-selection requests for the same
        // vendor - without this, two concurrent requests could both
        // read status=APPROVED and both create a VendorSubscription row
        // (a real duplicate, not just a harmless idempotent repeat).
        await tx.$queryRaw`SELECT id FROM vendors WHERE id = ${vendorId} FOR UPDATE`;

        const vendor = await tx.vendor.findUnique({ where: { id: vendorId } });
        if (!vendor) {
          throw new NotFoundException({
            code: 'VENDOR_NOT_FOUND',
            message: 'Vendor not found',
          });
        }

        if (
          vendor.status === 'ACTIVE' &&
          vendor.subscriptionStatus === 'ACTIVE'
        ) {
          const existing = await tx.vendorSubscription.findFirst({
            where: { vendorId },
            orderBy: { createdAt: 'desc' },
          });
          if (existing) {
            return { subscription: existing, alreadyActive: true };
          }
        }

        if (vendor.status !== 'APPROVED') {
          throw new ForbiddenException({
            code: 'VENDOR_NOT_APPROVED',
            message:
              'Only an approved vendor may select a subscription plan (FR-VEND-004)',
          });
        }

        const periodStart = new Date();
        const periodEnd = new Date(
          periodStart.getTime() + SANDBOX_PERIOD_DAYS * 24 * 60 * 60 * 1000,
        );

        const created = await tx.vendorSubscription.create({
          data: {
            vendorId,
            plan: dto.plan,
            status: 'ACTIVE',
            periodStart,
            periodEnd,
          },
        });

        await tx.vendor.update({
          where: { id: vendorId },
          data: { status: 'ACTIVE', subscriptionStatus: 'ACTIVE' },
        });

        await this.auditLog.record(
          {
            actorId: user.id,
            correlationId: req.correlationId,
            action: 'vendor_subscription.selected',
            entityType: 'VendorSubscription',
            entityId: created.id,
            afterState: { plan: created.plan, status: created.status },
          },
          tx,
        );
        await this.auditLog.record(
          {
            actorId: user.id,
            correlationId: req.correlationId,
            action: 'vendor.activated',
            entityType: 'Vendor',
            entityId: vendorId,
            afterState: { status: 'ACTIVE' },
          },
          tx,
        );

        return { subscription: created, alreadyActive: false };
      },
    );

    if (alreadyActive) {
      throw new ConflictException({
        code: 'SUBSCRIPTION_ALREADY_ACTIVE',
        message: 'This vendor already has an active subscription',
      });
    }

    return this.toDto(subscription);
  }
}
