import {
  BadRequestException,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Put,
  Req,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { Request } from 'express';
import {
  PlatformAlertCategory,
  PlatformRole,
} from '../../generated/prisma/client';
import { CurrentUser } from '../auth/current-user.decorator';
import { RequirePlatformRole } from '../auth/platform-role.decorator';
import { PlatformRoleGuard } from '../auth/platform-role.guard';
import {
  AuthenticatedUser,
  SessionAuthGuard,
} from '../auth/session-auth.guard';
import { IdempotencyCompletionService } from '../common/idempotency/idempotency-completion.service';
import { IdempotencyInterceptor } from '../common/idempotency/idempotency.interceptor';
import { PrismaService } from '../prisma/prisma.service';
import { PlatformAlertRecipientsService } from './platform-alert-recipients.service';

const CATEGORIES = Object.values(PlatformAlertCategory);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function parseCategory(raw: string): PlatformAlertCategory {
  const category = raw?.trim().toUpperCase() as PlatformAlertCategory;
  if (!CATEGORIES.includes(category)) {
    throw new BadRequestException({
      code: 'INVALID_ALERT_CATEGORY',
      message: `category must be one of ${CATEGORIES.join(', ')}`,
    });
  }
  return category;
}

function parseUserId(raw: string): string {
  if (!UUID.test(raw)) {
    throw new BadRequestException({
      code: 'INVALID_USER_ID',
      message: 'user id must be a UUID',
    });
  }
  return raw.toLowerCase();
}

/**
 * TB-12.2: who receives platform alerts, per category - PLATFORM_ADMIN
 * only (a verification reviewer, a store or a customer gets 403/401 and
 * never sees who the administrators are). PUT subscribes, DELETE
 * unsubscribes; both are naturally idempotent (repeating either changes
 * nothing and writes no second audit row) and also honour an
 * Idempotency-Key, completed in the same transaction as the change.
 * The role is required on EACH route: PlatformRoleGuard reads it from
 * the handler only, so a class-level @RequirePlatformRole would be
 * silently ignored and leave these routes open to any signed-in user.
 */
@Controller('admin/alert-recipients')
@UseGuards(SessionAuthGuard, PlatformRoleGuard)
export class AdminAlertRecipientsController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly recipients: PlatformAlertRecipientsService,
    private readonly idempotencyCompletion: IdempotencyCompletionService,
  ) {}

  @Get()
  @RequirePlatformRole(PlatformRole.PLATFORM_ADMIN)
  overview() {
    return this.recipients.overview();
  }

  @Put(':category/:userId')
  @RequirePlatformRole(PlatformRole.PLATFORM_ADMIN)
  @HttpCode(200)
  @UseInterceptors(IdempotencyInterceptor)
  async add(
    @Param('category') categoryRaw: string,
    @Param('userId') userIdRaw: string,
    @CurrentUser() user: AuthenticatedUser,
    @Req() req: Request,
  ) {
    const category = parseCategory(categoryRaw);
    const userId = parseUserId(userIdRaw);
    return this.prisma.$transaction(async (tx) => {
      const { added } = await this.recipients.add(
        tx,
        category,
        userId,
        user.id,
        req.correlationId,
      );
      const body = {
        category,
        user_id: userId,
        subscribed: true,
        changed: added,
      };
      await this.idempotencyCompletion.complete(
        tx,
        req.idempotencyClaimId,
        body,
        200,
      );
      return body;
    });
  }

  @Delete(':category/:userId')
  @RequirePlatformRole(PlatformRole.PLATFORM_ADMIN)
  @HttpCode(200)
  @UseInterceptors(IdempotencyInterceptor)
  async remove(
    @Param('category') categoryRaw: string,
    @Param('userId') userIdRaw: string,
    @CurrentUser() user: AuthenticatedUser,
    @Req() req: Request,
  ) {
    const category = parseCategory(categoryRaw);
    const userId = parseUserId(userIdRaw);
    return this.prisma.$transaction(async (tx) => {
      const { removed } = await this.recipients.remove(
        tx,
        category,
        userId,
        user.id,
        req.correlationId,
      );
      const body = {
        category,
        user_id: userId,
        subscribed: false,
        changed: removed,
      };
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
