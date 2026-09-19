import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Request } from 'express';
import { VendorUserRole } from '../../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { VENDOR_ROLES_KEY } from './vendor-role.decorator';

export interface VendorMembership {
  vendorId: string;
  role: VendorUserRole;
  branchId: string | null;
}

declare module 'express' {
  interface Request {
    vendorMembership?: VendorMembership;
  }
}

/**
 * Sprint 4 (RB-ROLE-004, PDR-009): the one, reusable, backend-enforced
 * authorization check for every vendor-scoped route this project builds
 * from here on - deliberately not left to the frontend to "hide the
 * button" for. Must run after `SessionAuthGuard` (reads `req.user`,
 * same fail-loud convention as `PlatformRoleGuard`). Requires the
 * route to have a `:vendorId` param.
 *
 * Three checks, in order:
 * 1. Membership: the caller must be a `VendorUser` of the named vendor
 *    at all - otherwise 403 `NOT_VENDOR_MEMBER` (matches the existing
 *    `NOT_VENDOR_OWNER` convention already used throughout this
 *    codebase's vendor-scoped controllers, not a new information-
 *    leak surface).
 * 2. `@RequireVendorRole(...)`: if the route declares specific roles
 *    (PDR-009's owner-only actions - staff invites, store config,
 *    prices, media, analytics), the caller's role must be one of them.
 * 3. Branch scoping: if the route also has a `:branchId` param, a
 *    BRANCH_EMPLOYEE caller's own assigned branch must match it
 *    exactly - PDR-009's "an employee controls only the assigned
 *    branch['s]... and cannot edit ... another branch." An OWNER is
 *    vendor-wide and is never subject to this check.
 *
 * On success, attaches `req.vendorMembership` so handlers never need
 * to re-query `VendorUser` themselves just to know the caller's own
 * role/branch.
 */
@Injectable()
export class VendorMembershipGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly prisma: PrismaService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<Request>();
    if (!request.user) {
      throw new ForbiddenException({
        code: 'FORBIDDEN',
        message:
          'VendorMembershipGuard used on a route with no SessionAuthGuard',
      });
    }

    // Express types params as string | string[] to account for
    // wildcard/repeatable route segments - never the case for a named
    // :vendorId segment as this guard is always used.
    const vendorId = request.params.vendorId as string | undefined;
    if (!vendorId) {
      throw new ForbiddenException({
        code: 'FORBIDDEN',
        message:
          'VendorMembershipGuard used on a route with no :vendorId param',
      });
    }

    const membership = await this.prisma.vendorUser.findUnique({
      where: { userId_vendorId: { userId: request.user.id, vendorId } },
    });
    if (!membership) {
      throw new ForbiddenException({
        code: 'NOT_VENDOR_MEMBER',
        message: 'You are not a member of this vendor account',
      });
    }

    const requiredRoles = this.reflector.get<VendorUserRole[]>(
      VENDOR_ROLES_KEY,
      context.getHandler(),
    );
    if (requiredRoles?.length && !requiredRoles.includes(membership.role)) {
      throw new ForbiddenException({
        code: 'VENDOR_ROLE_FORBIDDEN',
        message: 'Your role in this vendor account cannot perform this action',
      });
    }

    const branchId = request.params.branchId as string | undefined;
    if (
      branchId &&
      membership.role === 'BRANCH_EMPLOYEE' &&
      membership.branchId !== branchId
    ) {
      throw new ForbiddenException({
        code: 'BRANCH_ACCESS_DENIED',
        message: 'You are not assigned to this branch',
      });
    }

    request.vendorMembership = {
      vendorId,
      role: membership.role,
      branchId: membership.branchId,
    };
    return true;
  }
}
