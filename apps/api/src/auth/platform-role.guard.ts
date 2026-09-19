import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Request } from 'express';
import { PlatformRole } from '../../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { PLATFORM_ROLES_KEY } from './platform-role.decorator';

/**
 * Enforces `@RequirePlatformRole(...)`. Must run after SessionAuthGuard
 * - it reads `req.user.id`, which only that guard populates, and throws
 * (rather than silently passing) if used without it, matching
 * CurrentUser's same fail-loud convention.
 *
 * There is no self-service way for a user to acquire a PlatformRole -
 * see User.platformRole's schema comment. This guard is purely a read
 * check against whatever role was assigned out-of-band.
 */
@Injectable()
export class PlatformRoleGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly prisma: PrismaService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const required = this.reflector.get<PlatformRole[]>(
      PLATFORM_ROLES_KEY,
      context.getHandler(),
    );
    if (!required || required.length === 0) {
      return true;
    }

    const request = context.switchToHttp().getRequest<Request>();
    if (!request.user) {
      throw new ForbiddenException({
        code: 'FORBIDDEN',
        message: 'PlatformRoleGuard used on a route with no SessionAuthGuard',
      });
    }

    const user = await this.prisma.user.findUnique({
      where: { id: request.user.id },
      select: { platformRole: true },
    });

    if (!user?.platformRole || !required.includes(user.platformRole)) {
      throw new ForbiddenException({
        code: 'FORBIDDEN',
        message: 'This action requires a platform staff role',
      });
    }

    return true;
  }
}
