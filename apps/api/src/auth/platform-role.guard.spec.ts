import { ExecutionContext, ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { PrismaService } from '../prisma/prisma.service';
import { RedisService } from '../redis/redis.service';
import { PlatformRoleGuard } from './platform-role.guard';

const NO_REDIS = {} as unknown as RedisService;

function makeContext(user?: { id: string }, required?: string[]) {
  const req: { user?: { id: string } } = { user };
  const context = {
    switchToHttp: () => ({ getRequest: () => req }),
    getHandler: () => ({}),
  } as unknown as ExecutionContext;
  const reflector = { get: jest.fn().mockReturnValue(required) };
  return { context, reflector };
}

function makePrisma(platformRole: string | null) {
  return {
    user: { findUnique: jest.fn().mockResolvedValue({ platformRole }) },
    // TB-26: workspace_scoping_enabled off (no row) - the workspace
    // check is a no-op; it has its own e2e coverage.
    featureFlag: { findUnique: jest.fn().mockResolvedValue(null) },
  };
}

describe('PlatformRoleGuard', () => {
  it('allows the request through untouched when the route has no @RequirePlatformRole', async () => {
    const { context, reflector } = makeContext({ id: 'u1' }, undefined);
    const prisma = { user: { findUnique: jest.fn() } };
    const guard = new PlatformRoleGuard(
      reflector as unknown as Reflector,
      prisma as unknown as PrismaService,
      NO_REDIS,
    );

    await expect(guard.canActivate(context)).resolves.toBe(true);
    expect(prisma.user.findUnique).not.toHaveBeenCalled();
  });

  it('throws if used on a route with no SessionAuthGuard (req.user missing)', async () => {
    const { context, reflector } = makeContext(undefined, ['PLATFORM_ADMIN']);
    const prisma = makePrisma(null);
    const guard = new PlatformRoleGuard(
      reflector as unknown as Reflector,
      prisma as unknown as PrismaService,
      NO_REDIS,
    );

    await expect(guard.canActivate(context)).rejects.toBeInstanceOf(
      ForbiddenException,
    );
  });

  it('rejects a user with no platformRole at all', async () => {
    const { context, reflector } = makeContext({ id: 'u1' }, [
      'PLATFORM_ADMIN',
    ]);
    const prisma = makePrisma(null);
    const guard = new PlatformRoleGuard(
      reflector as unknown as Reflector,
      prisma as unknown as PrismaService,
      NO_REDIS,
    );

    await expect(guard.canActivate(context)).rejects.toBeInstanceOf(
      ForbiddenException,
    );
  });

  it('rejects a user whose platformRole is not in the required set', async () => {
    const { context, reflector } = makeContext({ id: 'u1' }, [
      'PLATFORM_ADMIN',
    ]);
    const prisma = makePrisma('VERIFICATION_REVIEWER');
    const guard = new PlatformRoleGuard(
      reflector as unknown as Reflector,
      prisma as unknown as PrismaService,
      NO_REDIS,
    );

    await expect(guard.canActivate(context)).rejects.toBeInstanceOf(
      ForbiddenException,
    );
  });

  it('allows a user whose platformRole is in the required set', async () => {
    const { context, reflector } = makeContext({ id: 'u1' }, [
      'VERIFICATION_REVIEWER',
      'PLATFORM_ADMIN',
    ]);
    const prisma = makePrisma('VERIFICATION_REVIEWER');
    const guard = new PlatformRoleGuard(
      reflector as unknown as Reflector,
      prisma as unknown as PrismaService,
      NO_REDIS,
    );

    await expect(guard.canActivate(context)).resolves.toBe(true);
  });
});
