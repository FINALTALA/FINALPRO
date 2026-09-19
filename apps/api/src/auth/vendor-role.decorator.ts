import { SetMetadata } from '@nestjs/common';
import { VendorUserRole } from '../../generated/prisma/client';

export const VENDOR_ROLES_KEY = 'vendor_roles';

/**
 * Marks a route as requiring one of the given `VendorUserRole`s within
 * the vendor named by the route's `:vendorId` param (PDR-009's
 * owner-only actions - staff invites, store configuration, prices,
 * media, analytics). Omit it entirely for a route any member (OWNER or
 * BRANCH_EMPLOYEE) may call - `VendorMembershipGuard` still enforces
 * plain membership and branch-scoping either way.
 */
export const RequireVendorRole = (...roles: VendorUserRole[]) =>
  SetMetadata(VENDOR_ROLES_KEY, roles);
