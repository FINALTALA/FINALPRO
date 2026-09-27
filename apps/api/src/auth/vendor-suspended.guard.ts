import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  SetMetadata,
  UseGuards,
  applyDecorators,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Request } from 'express';
import { PrismaService } from '../prisma/prisma.service';

export const BLOCK_WHEN_SUSPENDED_KEY = 'blockWhenSuspended';

@Injectable()
export class VendorSuspendedGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly prisma: PrismaService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const blocked =
      this.reflector.get<boolean>(
        BLOCK_WHEN_SUSPENDED_KEY,
        context.getHandler(),
      ) ??
      this.reflector.get<boolean>(BLOCK_WHEN_SUSPENDED_KEY, context.getClass());
    if (!blocked) return true;

    const request = context.switchToHttp().getRequest<Request>();
    const vendorId = request.params?.vendorId as string | undefined;
    const userId = request.user?.id;
    if (!vendorId || !userId) return true;

    // Only a member is told the store is suspended. A non-member falls
    // through to VendorMembershipGuard's own NOT_VENDOR_MEMBER, so this
    // guard can never be used to probe a store's state - and that holds
    // whatever order the two guards end up running in.
    const membership = await this.prisma.vendorUser.findFirst({
      where: { userId, vendorId },
      select: { id: true },
    });
    if (!membership) return true;

    // Best-effort at request start. A write that began a moment before a
    // suspension commits may still finish; that has no customer-facing
    // effect because public visibility and purchasability are
    // re-checked (status === 'ACTIVE') at read/confirm time under lock.
    const vendor = await this.prisma.vendor.findUnique({
      where: { id: vendorId },
      select: { status: true },
    });
    if (vendor?.status === 'SUSPENDED') {
      throw new ForbiddenException({
        code: 'VENDOR_SUSPENDED',
        message: 'This store is suspended and cannot make this change',
      });
    }
    return true;
  }
}

/**
 * Sprint 16 (L-23, FR-VEND-009): marks a vendor-scoped route as one a
 * SUSPENDED vendor may NOT call (catalog, offers, media, import,
 * inventory movements, storefront, sections). Routes without it stay
 * open - order fulfilment, reads, subscription renewal, store
 * configuration. The complete deny/allow classification lives in
 * vendor-route-classification.ts and is enforced by a test that fails
 * on any unclassified `vendors/:vendorId/*` route.
 *
 * Also attaches VendorSuspendedGuard, so a route needs only this one
 * decorator; ordering relative to VendorMembershipGuard does not matter
 * (see VendorSuspendedGuard.canActivate).
 */
export const BlockWhenSuspended = () =>
  applyDecorators(
    SetMetadata(BLOCK_WHEN_SUSPENDED_KEY, true),
    UseGuards(VendorSuspendedGuard),
  );
