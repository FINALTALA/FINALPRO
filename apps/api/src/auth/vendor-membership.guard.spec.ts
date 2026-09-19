import { ExecutionContext, ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { PrismaService } from '../prisma/prisma.service';
import { VendorMembershipGuard } from './vendor-membership.guard';

function makeContext(
  user: { id: string } | undefined,
  params: { vendorId?: string; branchId?: string },
  requiredRoles?: string[],
) {
  const req: {
    user?: { id: string };
    params: { vendorId?: string; branchId?: string };
    vendorMembership?: unknown;
  } = { user, params };
  const context = {
    switchToHttp: () => ({ getRequest: () => req }),
    getHandler: () => ({}),
  } as unknown as ExecutionContext;
  const reflector = { get: jest.fn().mockReturnValue(requiredRoles) };
  return { context, req, reflector };
}

function makePrisma(
  membership: { role: string; branchId: string | null } | null,
) {
  return {
    vendorUser: { findUnique: jest.fn().mockResolvedValue(membership) },
  };
}

describe('VendorMembershipGuard', () => {
  it('throws if used on a route with no SessionAuthGuard (req.user missing)', async () => {
    const { context, reflector } = makeContext(undefined, {
      vendorId: 'v1',
    });
    const prisma = makePrisma(null);
    const guard = new VendorMembershipGuard(
      reflector as unknown as Reflector,
      prisma as unknown as PrismaService,
    );

    await expect(guard.canActivate(context)).rejects.toBeInstanceOf(
      ForbiddenException,
    );
  });

  it('throws if used on a route with no :vendorId param', async () => {
    const { context, reflector } = makeContext({ id: 'u1' }, {});
    const prisma = makePrisma(null);
    const guard = new VendorMembershipGuard(
      reflector as unknown as Reflector,
      prisma as unknown as PrismaService,
    );

    await expect(guard.canActivate(context)).rejects.toBeInstanceOf(
      ForbiddenException,
    );
  });

  it('rejects (NOT_VENDOR_MEMBER) a user with no VendorUser row for this vendor at all - the base BOLA case', async () => {
    const { context, reflector } = makeContext(
      { id: 'u1' },
      {
        vendorId: 'v1',
      },
    );
    const prisma = makePrisma(null);
    const guard = new VendorMembershipGuard(
      reflector as unknown as Reflector,
      prisma as unknown as PrismaService,
    );

    await expect(guard.canActivate(context)).rejects.toMatchObject({
      response: { code: 'NOT_VENDOR_MEMBER' },
    });
  });

  it('allows a member with no :branchId route param and no @RequireVendorRole restriction (plain membership route)', async () => {
    const { context, req, reflector } = makeContext(
      { id: 'u1' },
      { vendorId: 'v1' },
    );
    const prisma = makePrisma({ role: 'OWNER', branchId: null });
    const guard = new VendorMembershipGuard(
      reflector as unknown as Reflector,
      prisma as unknown as PrismaService,
    );

    await expect(guard.canActivate(context)).resolves.toBe(true);
    expect(req.vendorMembership).toEqual({
      vendorId: 'v1',
      role: 'OWNER',
      branchId: null,
    });
  });

  it('rejects (VENDOR_ROLE_FORBIDDEN) a BRANCH_EMPLOYEE on a route marked @RequireVendorRole(OWNER)', async () => {
    const { context, reflector } = makeContext(
      { id: 'u1' },
      { vendorId: 'v1' },
      ['OWNER'],
    );
    const prisma = makePrisma({ role: 'BRANCH_EMPLOYEE', branchId: 'b1' });
    const guard = new VendorMembershipGuard(
      reflector as unknown as Reflector,
      prisma as unknown as PrismaService,
    );

    await expect(guard.canActivate(context)).rejects.toMatchObject({
      response: { code: 'VENDOR_ROLE_FORBIDDEN' },
    });
  });

  it('allows an OWNER through an @RequireVendorRole(OWNER) route', async () => {
    const { context, reflector } = makeContext(
      { id: 'u1' },
      { vendorId: 'v1' },
      ['OWNER'],
    );
    const prisma = makePrisma({ role: 'OWNER', branchId: null });
    const guard = new VendorMembershipGuard(
      reflector as unknown as Reflector,
      prisma as unknown as PrismaService,
    );

    await expect(guard.canActivate(context)).resolves.toBe(true);
  });

  it('rejects (BRANCH_ACCESS_DENIED) a BRANCH_EMPLOYEE whose own branchId does not match the route :branchId - the cross-branch BOLA case', async () => {
    const { context, reflector } = makeContext(
      { id: 'u1' },
      { vendorId: 'v1', branchId: 'branch-B' },
    );
    const prisma = makePrisma({
      role: 'BRANCH_EMPLOYEE',
      branchId: 'branch-A',
    });
    const guard = new VendorMembershipGuard(
      reflector as unknown as Reflector,
      prisma as unknown as PrismaService,
    );

    await expect(guard.canActivate(context)).rejects.toMatchObject({
      response: { code: 'BRANCH_ACCESS_DENIED' },
    });
  });

  it('allows a BRANCH_EMPLOYEE whose own branchId matches the route :branchId', async () => {
    const { context, req, reflector } = makeContext(
      { id: 'u1' },
      { vendorId: 'v1', branchId: 'branch-A' },
    );
    const prisma = makePrisma({
      role: 'BRANCH_EMPLOYEE',
      branchId: 'branch-A',
    });
    const guard = new VendorMembershipGuard(
      reflector as unknown as Reflector,
      prisma as unknown as PrismaService,
    );

    await expect(guard.canActivate(context)).resolves.toBe(true);
    expect(req.vendorMembership).toEqual({
      vendorId: 'v1',
      role: 'BRANCH_EMPLOYEE',
      branchId: 'branch-A',
    });
  });

  it('never applies branch-scoping to an OWNER, even when :branchId is present and belongs to a different branch than any they are "assigned" to (owners have none)', async () => {
    const { context, reflector } = makeContext(
      { id: 'u1' },
      { vendorId: 'v1', branchId: 'branch-B' },
    );
    const prisma = makePrisma({ role: 'OWNER', branchId: null });
    const guard = new VendorMembershipGuard(
      reflector as unknown as Reflector,
      prisma as unknown as PrismaService,
    );

    await expect(guard.canActivate(context)).resolves.toBe(true);
  });
});
