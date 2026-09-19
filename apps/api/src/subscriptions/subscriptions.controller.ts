import {
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
import { IdempotencyCompletionService } from '../common/idempotency/idempotency-completion.service';
import { IdempotencyInterceptor } from '../common/idempotency/idempotency.interceptor';
import { PrismaService } from '../prisma/prisma.service';
import { SubscriptionGateService } from './subscription-gate.service';

/**
 * Sprint 3 remediation (PDR-033, approved-product-decisions-2026-09.md):
 * "a unified sandbox/trial subscription begins after verification,
 * lasts one month and has mock monthly renewal. No Basic/Pro logic
 * now." Replaces the pre-remediation Basic/Standard/Premium plan
 * selection (S3-B02) - `activate()` takes no plan parameter at all.
 * No real payment gateway is built here, the same sandbox pattern
 * already used for OPEN-001 (payment) and OPEN-004 (SMS): `renew()` is
 * an explicit, visible, simulated action standing in for what a real
 * monthly billing cron would do invisibly - this codebase has no
 * scheduled-job worker to do that for real.
 */
@Controller('vendors/:vendorId/subscription')
@UseGuards(SessionAuthGuard)
export class SubscriptionsController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auditLog: AuditLogService,
    private readonly idempotencyCompletion: IdempotencyCompletionService,
    private readonly subscriptionGate: SubscriptionGateService,
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
    status: string;
    periodStart: Date;
    periodEnd: Date;
  }) {
    return {
      id: sub.id,
      vendor_id: sub.vendorId,
      status: sub.status,
      period_start: sub.periodStart.toISOString(),
      period_end: sub.periodEnd.toISOString(),
      simulated: true as const,
    };
  }

  @Get()
  async current(
    @Param('vendorId') vendorId: string,
    @CurrentUser() user: AuthenticatedUser,
    @Req() req: Request,
  ) {
    await this.requireOwner(vendorId, user.id);
    return this.prisma.$transaction(async (tx) => {
      await this.subscriptionGate.refreshStatus(
        tx,
        vendorId,
        req.correlationId,
      );
      const sub = await tx.vendorSubscription.findFirst({
        where: { vendorId },
        orderBy: { createdAt: 'desc' },
      });
      if (!sub) {
        throw new NotFoundException({
          code: 'NO_SUBSCRIPTION',
          message: 'This vendor has not activated a trial yet',
        });
      }
      return this.toDto(sub);
    });
  }

  @Post()
  @HttpCode(201)
  @UseInterceptors(IdempotencyInterceptor)
  async activate(
    @Param('vendorId') vendorId: string,
    @CurrentUser() user: AuthenticatedUser,
    @Req() req: Request,
  ) {
    await this.requireOwner(vendorId, user.id);

    const { subscription, alreadyActive } = await this.prisma.$transaction(
      async (tx) => {
        // Serializes concurrent activation requests for the same vendor -
        // without this, two concurrent requests could both read
        // status=APPROVED and both create a VendorSubscription row (a
        // real duplicate, not just a harmless idempotent repeat).
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
            return { subscription: this.toDto(existing), alreadyActive: true };
          }
        }

        if (vendor.status !== 'APPROVED') {
          throw new ForbiddenException({
            code: 'VENDOR_NOT_APPROVED',
            message:
              'Only an approved vendor may activate its trial subscription (FR-VEND-004)',
          });
        }

        const periodStart = new Date();
        const periodEnd = new Date(
          periodStart.getTime() +
            SubscriptionGateService.SANDBOX_PERIOD_DAYS * 24 * 60 * 60 * 1000,
        );

        const created = await tx.vendorSubscription.create({
          data: { vendorId, status: 'ACTIVE', periodStart, periodEnd },
        });

        await tx.vendor.update({
          where: { id: vendorId },
          data: { status: 'ACTIVE', subscriptionStatus: 'ACTIVE' },
        });

        await this.auditLog.record(
          {
            actorId: user.id,
            correlationId: req.correlationId,
            action: 'vendor_subscription.activated',
            entityType: 'VendorSubscription',
            entityId: created.id,
            afterState: { status: created.status },
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

        const body = this.toDto(created);
        await this.idempotencyCompletion.complete(
          tx,
          req.idempotencyClaimId,
          body,
          201,
        );
        return { subscription: body, alreadyActive: false };
      },
    );

    if (alreadyActive) {
      throw new ConflictException({
        code: 'SUBSCRIPTION_ALREADY_ACTIVE',
        message: 'This vendor already has an active trial subscription',
      });
    }

    return subscription;
  }

  // PDR-033's "mock monthly renewal... renewal restores automatically" -
  // simulated here as an explicit sandbox action (see the class-level
  // comment for why) rather than an invisible scheduled job. Only valid
  // once the trial has actually lapsed (EXPIRED) - renewing one that's
  // still ACTIVE isn't a real-world action a monthly billing cycle would
  // ever take early.
  @Post('renew')
  @HttpCode(200)
  @UseInterceptors(IdempotencyInterceptor)
  async renew(
    @Param('vendorId') vendorId: string,
    @CurrentUser() user: AuthenticatedUser,
    @Req() req: Request,
  ) {
    await this.requireOwner(vendorId, user.id);

    return this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM vendors WHERE id = ${vendorId} FOR UPDATE`;

      const status = await this.subscriptionGate.refreshStatus(
        tx,
        vendorId,
        req.correlationId,
      );
      if (status !== 'EXPIRED') {
        throw new ConflictException({
          code: 'SUBSCRIPTION_NOT_EXPIRED',
          message:
            "Only an expired trial can be renewed - this vendor's subscription is not expired",
        });
      }

      const current = await tx.vendorSubscription.findFirstOrThrow({
        where: { vendorId },
        orderBy: { createdAt: 'desc' },
      });

      const periodStart = new Date();
      const periodEnd = new Date(
        periodStart.getTime() +
          SubscriptionGateService.SANDBOX_PERIOD_DAYS * 24 * 60 * 60 * 1000,
      );
      const renewed = await tx.vendorSubscription.update({
        where: { id: current.id },
        data: { status: 'ACTIVE', periodStart, periodEnd },
      });
      await tx.vendor.update({
        where: { id: vendorId },
        data: { subscriptionStatus: 'ACTIVE' },
      });

      await this.auditLog.record(
        {
          actorId: user.id,
          correlationId: req.correlationId,
          action: 'vendor_subscription.mock_renewed',
          entityType: 'VendorSubscription',
          entityId: renewed.id,
          beforeState: { status: 'EXPIRED' },
          afterState: { status: 'ACTIVE', period_end: periodEnd.toISOString() },
        },
        tx,
      );

      const body = this.toDto(renewed);
      await this.idempotencyCompletion.complete(
        tx,
        req.idempotencyClaimId,
        body,
        200,
      );
      return body;
    });
  }
}
