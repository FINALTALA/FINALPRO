import { ExecutionContext, UnauthorizedException } from '@nestjs/common';
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

describe('SessionAuthGuard', () => {
  it('rejects a request with no Authorization header', async () => {
    const sessions = { get: jest.fn() };
    const guard = new SessionAuthGuard(sessions as unknown as SessionService);
    const { context } = makeContext({});

    await expect(guard.canActivate(context)).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
    expect(sessions.get).not.toHaveBeenCalled();
  });

  it('rejects a header that is not a Bearer token', async () => {
    const sessions = { get: jest.fn() };
    const guard = new SessionAuthGuard(sessions as unknown as SessionService);
    const { context } = makeContext({ Authorization: 'Basic abc123' });

    await expect(guard.canActivate(context)).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });

  it('rejects a Bearer token that does not resolve to a session', async () => {
    const sessions = { get: jest.fn().mockResolvedValue(null) };
    const guard = new SessionAuthGuard(sessions as unknown as SessionService);
    const { context } = makeContext({ Authorization: 'Bearer bad-token' });

    await expect(guard.canActivate(context)).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });

  it('attaches req.user and allows the request through for a valid session', async () => {
    const sessions = {
      get: jest.fn().mockResolvedValue({
        userId: 'user-1',
        phone: '+970000000001',
        phoneVerifiedAt: '2026-01-01T00:00:00.000Z',
      }),
    };
    const guard = new SessionAuthGuard(sessions as unknown as SessionService);
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
});
