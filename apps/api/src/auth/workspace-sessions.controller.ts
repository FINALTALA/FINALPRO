import {
  Body,
  Controller,
  Delete,
  ForbiddenException,
  HttpCode,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { Request } from 'express';
import { AuditLogService } from '../audit/audit-log.service';
import { PrismaService } from '../prisma/prisma.service';
import { RedisService } from '../redis/redis.service';
import { CurrentUser } from './current-user.decorator';
import { CreateWorkspaceSessionDto } from './dto/workspace-session.dto';
import { AuthenticatedUser, SessionAuthGuard } from './session-auth.guard';
import {
  createWorkspaceSession,
  readWorkspaceSession,
  revokeWorkspaceSession,
  sessionHash,
  WORKSPACE_HEADER,
  WorkspaceNeutral,
} from './workspace-session';

/**
 * TB-26: entering and leaving a workspace (see workspace-session.ts).
 * Entering is an explicit step the web app takes from its confirmation
 * page - never automatically on sign-in. The permission is checked here
 * (an ACTIVE membership of that store / a platform role on an active
 * account) and again by the guards on every later request.
 */
@Controller('me/workspace-sessions')
@UseGuards(SessionAuthGuard)
@WorkspaceNeutral()
export class WorkspaceSessionsController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
    private readonly auditLog: AuditLogService,
  ) {}

  @Post()
  @HttpCode(201)
  async enter(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: CreateWorkspaceSessionDto,
    @Req() req: Request,
  ) {
    const account = await this.prisma.user.findUnique({
      where: { id: user.id },
      select: { platformRole: true, deactivatedAt: true },
    });
    if (!account || account.deactivatedAt) {
      throw new ForbiddenException({
        code: 'FORBIDDEN',
        message: 'This account cannot enter a workspace',
      });
    }

    let vendorId: string | null = null;
    let role: string | null = null;
    let branchId: string | null = null;
    if (dto.type === 'vendor') {
      const membership = await this.prisma.vendorUser.findUnique({
        where: {
          userId_vendorId: { userId: user.id, vendorId: dto.vendor_id! },
        },
      });
      if (!membership) {
        throw new ForbiddenException({
          code: 'NOT_VENDOR_MEMBER',
          message: 'You are not a member of this vendor account',
        });
      }
      if (membership.status !== 'ACTIVE') {
        throw new ForbiddenException({
          code: 'STAFF_SUSPENDED',
          message: 'Your membership in this vendor account has been suspended',
        });
      }
      vendorId = membership.vendorId;
      role = membership.role;
      branchId = membership.branchId;
    } else {
      if (!account.platformRole) {
        throw new ForbiddenException({
          code: 'FORBIDDEN',
          message: 'This action requires a platform staff role',
        });
      }
      role = account.platformRole;
    }

    const { token, expiresInSeconds } = await createWorkspaceSession(
      this.redis,
      {
        userId: user.id,
        sessionHash: sessionHash(req.sessionToken!),
        kind: dto.type === 'vendor' ? 'VENDOR' : 'PLATFORM',
        vendorId,
      },
    );
    await this.auditLog.record({
      actorId: user.id,
      correlationId: req.correlationId,
      action: 'workspace.entered',
      entityType: dto.type === 'vendor' ? 'Vendor' : 'Platform',
      entityId: vendorId ?? 'platform',
      afterState: { role, branch_id: branchId },
    });
    return {
      workspace_token: token,
      type: dto.type,
      vendor_id: vendorId,
      role,
      branch_id: branchId,
      expires_in_seconds: expiresInSeconds,
    };
  }

  /** Leaving: revokes the token in X-Workspace-Token when it belongs to
   * this session; anything else is a no-op (idempotent, and never says
   * whether some other token exists). */
  @Delete('current')
  @HttpCode(204)
  async leave(
    @CurrentUser() user: AuthenticatedUser,
    @Req() req: Request,
  ): Promise<void> {
    const token = req.header(WORKSPACE_HEADER);
    if (!token) return;
    const ws = await readWorkspaceSession(this.redis, token);
    if (
      ws &&
      ws.userId === user.id &&
      ws.sessionHash === sessionHash(req.sessionToken!)
    ) {
      await revokeWorkspaceSession(this.redis, token, ws);
    }
  }
}
