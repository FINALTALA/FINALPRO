import { ExecutionContext, UnauthorizedException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { SessionAuthGuard } from './session-auth.guard';
import { SessionService } from './session.service';

function makeContext(headers: Record<string, string>) {
  const req: { header: (n: string) => string | undefined; user?: unknown } = {
    header: (name: string) => headers[name] ?? headers[name.toLowerCase()],
  };
  return {
    context: {
      switchToHttp: () => ({ getRequest: () => req }),
    } as unknown as ExecutionContext,
    req,
  };
}

function makePrisma(sessionVersion: number | null) {
  return {
    user: {
      findUnique: jest
        .fn()
        .mockResolvedValue(sessionVersion === null ? null : { sessionVersion }),
    },
  };
}

describe('SessionAuthGuard', () => {
  it('rejects a request with no Authorization header', async () => {
    const sessions = { get: jest.fn() };
    const prisma = makePrisma(0);
    const guard = new SessionAuthGuard(
      sessions as unknown as SessionService,
      prisma as unknown as PrismaService,
    );
    const { context } = makeContext({});

    await expect(guard.canActivate(context)).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
    expect(sessions.get).not.toHaveBeenCalled();
  });

  it('rejects a header that is not a Bearer token', async () => {
    const sessions = { get: jest.fn() };
    const prisma = makePrisma(0);
    const guard = new SessionAuthGuard(
      sessions as unknown as SessionService,
      prisma as unknown as PrismaService,
    );
    const { context } = makeContext({ Authorization: 'Basic abc123' });

    await expect(guard.canActivate(context)).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });

  it('rejects a Bearer token that does not resolve to a session', async () => {
    const sessions = { get: jest.fn().mockResolvedValue(null) };
    const prisma = makePrisma(0);
    const guard = new SessionAuthGuard(
      sessions as unknown as SessionService,
      prisma as unknown as PrismaService,
    );
    const { context } = makeContext({ Authorization: 'Bearer bad-token' });

    await expect(guard.canActivate(context)).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });

  it('attaches req.user and allows the request through for a valid session with a matching sessionVersion', async () => {
    const sessions = {
      get: jest.fn().mockResolvedValue({
        userId: 'user-1',
        phone: '+970000000001',
        phoneVerifiedAt: '2026-01-01T00:00:00.000Z',
        sessionVersion: 0,
      }),
    };
    const prisma = makePrisma(0);
    const guard = new SessionAuthGuard(
      sessions as unknown as SessionService,
      prisma as unknown as PrismaService,
    );
    const { context, req } = makeContext({
      Authorization: 'Bearer good-token',
    });

    const allowed = await guard.canActivate(context);

    expect(allowed).toBe(true);
    expect(req.user).toEqual({
      id: 'user-1',
      phone: '+970000000001',
      phoneVerifiedAt: '2026-01-01T00:00:00.000Z',
    });
    expect(sessions.get).toHaveBeenCalledWith('good-token');
  });

  it("rejects a session whose sessionVersion is stale (e.g. a password reset bumped the user's current version since this session was issued)", async () => {
    const sessions = {
      get: jest.fn().mockResolvedValue({
        userId: 'user-1',
        phone: '+970000000001',
        phoneVerifiedAt: null,
        sessionVersion: 0, // this session was issued under version 0
      }),
    };
    const prisma = makePrisma(1); // user has since moved to version 1 (a password reset)
    const guard = new SessionAuthGuard(
      sessions as unknown as SessionService,
      prisma as unknown as PrismaService,
    );
    const { context } = makeContext({
      Authorization: 'Bearer stale-session-token',
    });

    await expect(guard.canActivate(context)).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });

  it('rejects a session for a user that no longer exists', async () => {
    const sessions = {
      get: jest.fn().mockResolvedValue({
        userId: 'deleted-user',
        phone: '+970000000001',
        phoneVerifiedAt: null,
        sessionVersion: 0,
      }),
    };
    const prisma = makePrisma(null);
    const guard = new SessionAuthGuard(
      sessions as unknown as SessionService,
      prisma as unknown as PrismaService,
    );
    const { context } = makeContext({
      Authorization: 'Bearer orphaned-token',
    });

    await expect(guard.canActivate(context)).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });
});
