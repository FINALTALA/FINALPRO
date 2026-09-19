import { SetMetadata } from '@nestjs/common';
import { PlatformRole } from '../../generated/prisma/client';

export const PLATFORM_ROLES_KEY = 'platform_roles';

/**
 * Marks a route as requiring one of the given platform staff roles
 * (FR-VEND-003's "vendor-verification-reviewer role", Part 1 §C).
 * Must be combined with `@UseGuards(SessionAuthGuard, PlatformRoleGuard)`
 * - PlatformRoleGuard reads this metadata and reads req.user (populated
 * by SessionAuthGuard) to check the acting user's PlatformRole.
 */
export const RequirePlatformRole = (...roles: PlatformRole[]) =>
  SetMetadata(PLATFORM_ROLES_KEY, roles);
