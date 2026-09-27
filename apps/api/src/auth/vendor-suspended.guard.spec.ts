import { ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import {
  BLOCK_WHEN_SUSPENDED_KEY,
  VendorSuspendedGuard,
} from './vendor-suspended.guard';

function build(opts: {
  blocked: boolean;
  user?: { id: string };
  vendorId?: string;
  membership: boolean;
  status: string;
}) {
  const findMember = jest
    .fn()
    .mockResolvedValue(opts.membership ? { id: 'vu' } : null);
  const findVendor = jest.fn().mockResolvedValue({ status: opts.status });
  const prisma = {
    vendorUser: { findFirst: findMember },
    vendor: { findUnique: findVendor },
  };
  const handler = () => undefined;
  class Ctl {}
  if (opts.blocked) {
    Reflect.defineMetadata(BLOCK_WHEN_SUSPENDED_KEY, true, handler);
  }
  const guard = new VendorSuspendedGuard(new Reflector(), prisma as never);
  const context = {
    getHandler: () => handler,
    getClass: () => Ctl,
    switchToHttp: () => ({
      getRequest: () => ({
        user: opts.user,
        params: { vendorId: opts.vendorId },
      }),
    }),
  };
  return { guard, context: context as never, findMember, findVendor };
}

describe('VendorSuspendedGuard', () => {
  it('does nothing on a route that is not marked (no queries at all)', async () => {
    const t = build({
      blocked: false,
      user: { id: 'u' },
      vendorId: 'v',
      membership: true,
      status: 'SUSPENDED',
    });
    await expect(t.guard.canActivate(t.context)).resolves.toBe(true);
    expect(t.findMember).not.toHaveBeenCalled();
    expect(t.findVendor).not.toHaveBeenCalled();
  });

  it('blocks a MEMBER of a SUSPENDED vendor with 403 VENDOR_SUSPENDED', async () => {
    const t = build({
      blocked: true,
      user: { id: 'u' },
      vendorId: 'v',
      membership: true,
      status: 'SUSPENDED',
    });
    let caught: unknown;
    try {
      await t.guard.canActivate(t.context);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(ForbiddenException);
    expect((caught as ForbiddenException).getResponse()).toMatchObject({
      code: 'VENDOR_SUSPENDED',
    });
  });

  it.each([
    'ACTIVE',
    'APPROVED',
    'UNDER_REVIEW',
    'REJECTED',
    'APPLIED',
    'CANCELLED',
  ])('lets a member through when the vendor is %s', async (status) => {
    const t = build({
      blocked: true,
      user: { id: 'u' },
      vendorId: 'v',
      membership: true,
      status,
    });
    await expect(t.guard.canActivate(t.context)).resolves.toBe(true);
  });

  it('never reveals the suspension to a non-member: lets the request through so VendorMembershipGuard answers NOT_VENDOR_MEMBER, and does not even read the vendor', async () => {
    const t = build({
      blocked: true,
      user: { id: 'stranger' },
      vendorId: 'v',
      membership: false,
      status: 'SUSPENDED',
    });
    await expect(t.guard.canActivate(t.context)).resolves.toBe(true);
    expect(t.findVendor).not.toHaveBeenCalled();
  });

  it('lets a request with no session through (SessionAuthGuard owns that 401)', async () => {
    const t = build({
      blocked: true,
      user: undefined,
      vendorId: 'v',
      membership: true,
      status: 'SUSPENDED',
    });
    await expect(t.guard.canActivate(t.context)).resolves.toBe(true);
  });
});
