import {
  createParamDecorator,
  ExecutionContext,
  InternalServerErrorException,
} from '@nestjs/common';
import { Request } from 'express';
import { VendorMembership } from './vendor-membership.guard';

/**
 * Only valid on a route behind `@UseGuards(SessionAuthGuard,
 * VendorMembershipGuard)`, which is what actually populates
 * `req.vendorMembership`. Throws rather than returning `undefined` if
 * used without it, matching `@CurrentUser()`'s same fail-loud
 * convention.
 */
export const CurrentVendorMembership = createParamDecorator(
  (_: unknown, ctx: ExecutionContext): VendorMembership => {
    const request = ctx.switchToHttp().getRequest<Request>();
    if (!request.vendorMembership) {
      throw new InternalServerErrorException(
        '@CurrentVendorMembership() used on a route with no VendorMembershipGuard',
      );
    }
    return request.vendorMembership;
  },
);
