import {
  ConflictException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { CallHandler, ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { createHash } from 'crypto';
import { of, throwError, firstValueFrom } from 'rxjs';
import { Prisma } from '../../../generated/prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { IdempotencyInterceptor } from './idempotency.interceptor';

function makeContext(opts: {
  headers?: Record<string, string>;
  path?: string;
  method?: string;
  body?: unknown;
  user?: { id: string };
}): ExecutionContext {
  const headers = opts.headers ?? {};
  const req = {
    header: (name: string) => headers[name.toLowerCase()] ?? headers[name],
    path: opts.path ?? '/api/v1/health/echo',
    method: opts.method ?? 'POST',
    body: opts.body ?? {},
    user: opts.user,
  };
  const res = {
    statusCode: 201,
    status: jest.fn().mockReturnThis(),
    setHeader: jest.fn(),
  };
  return {
    switchToHttp: () => ({
      getRequest: () => req,
      getResponse: () => res,
    }),
    getHandler: () => ({}),
  } as unknown as ExecutionContext;
}

function uniqueViolation(): Prisma.PrismaClientKnownRequestError {
  return new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
    code: 'P2002',
    clientVersion: 'test',
  });
}

describe('IdempotencyInterceptor', () => {
  let interceptor: IdempotencyInterceptor;
  let prisma: {
    idempotencyKey: {
      create: jest.Mock;
      findUnique: jest.Mock;
      update: jest.Mock;
      updateMany: jest.Mock;
    };
  };
  let handler: CallHandler;
  let reflector: { get: jest.Mock };

  beforeEach(() => {
    prisma = {
      idempotencyKey: {
        create: jest.fn(),
        findUnique: jest.fn(),
        update: jest.fn(),
        updateMany: jest.fn(),
      },
    };
    // No route in these tests overrides the TTL, so `get()` returning
    // undefined (falling back to the 24h default) matches every real
    // route except POST /auth/otp/verify (see idempotency-ttl.decorator.ts).
    reflector = { get: jest.fn().mockReturnValue(undefined) };
    interceptor = new IdempotencyInterceptor(
      prisma as unknown as PrismaService,
      reflector as unknown as Reflector,
    );
    handler = { handle: () => of({ echoed: true }) };
  });

  it('rejects a request with no Idempotency-Key header before touching Prisma', async () => {
    const context = makeContext({});
    await expect(
      interceptor.intercept(context, handler),
    ).rejects.toBeInstanceOf(UnprocessableEntityException);
    expect(prisma.idempotencyKey.create).not.toHaveBeenCalled();
  });

  it('claims a fresh key, runs the handler, and durably records the result', async () => {
    prisma.idempotencyKey.create.mockResolvedValue({ id: 'row-1' });
    prisma.idempotencyKey.update.mockResolvedValue({});

    const context = makeContext({ headers: { 'idempotency-key': 'k1' } });
    const result$ = await interceptor.intercept(context, handler);
    const result = await firstValueFrom(result$);

    expect(result).toEqual({ echoed: true });
    expect(prisma.idempotencyKey.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          key: 'k1',
          scope: 'anonymous',
          status: 'IN_PROGRESS',
        }),
      }),
    );
    expect(prisma.idempotencyKey.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'row-1' },
        data: expect.objectContaining({ status: 'COMPLETED' }),
      }),
    );
  });

  it("uses a route-overridden idempotency TTL (e.g. OTP verify's 5-minute window) instead of the 24h default", async () => {
    prisma.idempotencyKey.create.mockResolvedValue({ id: 'row-ttl' });
    prisma.idempotencyKey.update.mockResolvedValue({});
    const fiveMinutesMs = 5 * 60 * 1000;
    reflector.get.mockReturnValue(fiveMinutesMs);

    const context = makeContext({ headers: { 'idempotency-key': 'k-ttl' } });
    await interceptor.intercept(context, handler);

    const createCall = prisma.idempotencyKey.create.mock.calls[0][0];
    const expiresAt: Date = createCall.data.expiresAt;
    const deltaMs = expiresAt.getTime() - Date.now();
    // Close to the 5-minute override, nowhere near the 24h default.
    expect(deltaMs).toBeGreaterThan(fiveMinutesMs - 5_000);
    expect(deltaMs).toBeLessThan(fiveMinutesMs + 5_000);
  });

  it('replays the stored response for a duplicate key with the same payload, without calling the handler', async () => {
    prisma.idempotencyKey.create.mockRejectedValue(uniqueViolation());
    prisma.idempotencyKey.findUnique.mockResolvedValue({
      status: 'COMPLETED',
      requestHash: hashOf('POST', '/api/v1/health/echo', { hello: 'world' }),
      responseBody: { echoed: { hello: 'world' } },
      responseCode: 201,
    });
    const handlerSpy = jest.fn(() => of({ echoed: true }));
    const context = makeContext({
      headers: { 'idempotency-key': 'k2' },
      body: { hello: 'world' },
    });

    const result$ = await interceptor.intercept(context, {
      handle: handlerSpy,
    });
    const result = await firstValueFrom(result$);

    expect(handlerSpy).not.toHaveBeenCalled();
    expect(result).toEqual({ echoed: { hello: 'world' } });
  });

  it('returns 409 for a duplicate key whose stored request had a different payload', async () => {
    prisma.idempotencyKey.create.mockRejectedValue(uniqueViolation());
    prisma.idempotencyKey.findUnique.mockResolvedValue({
      status: 'COMPLETED',
      requestHash: hashOf('POST', '/api/v1/health/echo', { hello: 'ORIGINAL' }),
      responseBody: {},
      responseCode: 201,
    });
    const context = makeContext({
      headers: { 'idempotency-key': 'k3' },
      body: { hello: 'DIFFERENT' },
    });

    await expect(
      interceptor.intercept(context, handler),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('returns 409 for a duplicate key that is still IN_PROGRESS (a genuine concurrent race)', async () => {
    prisma.idempotencyKey.create.mockRejectedValue(uniqueViolation());
    prisma.idempotencyKey.findUnique.mockResolvedValue({
      status: 'IN_PROGRESS',
      createdAt: new Date(), // fresh, not stale
      requestHash: 'whatever',
    });
    const context = makeContext({ headers: { 'idempotency-key': 'k4' } });

    await expect(
      interceptor.intercept(context, handler),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('takes over a stale IN_PROGRESS claim (original owner crashed) instead of blocking forever, via an atomic compare-and-swap', async () => {
    prisma.idempotencyKey.create.mockRejectedValue(uniqueViolation());
    const staleCreatedAt = new Date(Date.now() - 60_000); // 60s old, past the 30s stale threshold
    prisma.idempotencyKey.findUnique.mockResolvedValue({
      id: 'row-5',
      status: 'IN_PROGRESS',
      createdAt: staleCreatedAt,
      requestHash: hashOf('POST', '/api/v1/health/echo', {}),
    });
    prisma.idempotencyKey.updateMany.mockResolvedValue({ count: 1 });
    prisma.idempotencyKey.update.mockResolvedValue({});

    const context = makeContext({ headers: { 'idempotency-key': 'k5' } });
    const result$ = await interceptor.intercept(context, handler);
    const result = await firstValueFrom(result$);

    expect(result).toEqual({ echoed: true });
    // The takeover is a CAS: the WHERE clause pins the exact id, status,
    // and createdAt just read, so a losing racer's stale WHERE clause
    // would no longer match and affect zero rows.
    expect(prisma.idempotencyKey.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          id: 'row-5',
          status: 'IN_PROGRESS',
          createdAt: staleCreatedAt,
        },
        data: expect.objectContaining({ status: 'IN_PROGRESS' }),
      }),
    );
  });

  it('refuses to take over a stale IN_PROGRESS claim when the new payload differs - returns 409 without ever calling updateMany', async () => {
    prisma.idempotencyKey.create.mockRejectedValue(uniqueViolation());
    prisma.idempotencyKey.findUnique.mockResolvedValue({
      id: 'row-9',
      status: 'IN_PROGRESS',
      createdAt: new Date(Date.now() - 60_000),
      requestHash: hashOf('POST', '/api/v1/health/echo', { hello: 'ORIGINAL' }),
    });
    const context = makeContext({
      headers: { 'idempotency-key': 'k9' },
      body: { hello: 'DIFFERENT' },
    });

    await expect(
      interceptor.intercept(context, handler),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(prisma.idempotencyKey.updateMany).not.toHaveBeenCalled();
  });

  it('retries a FAILED claim when the new payload matches (the earlier attempt crashed after claiming but before finishing)', async () => {
    prisma.idempotencyKey.create.mockRejectedValue(uniqueViolation());
    prisma.idempotencyKey.findUnique.mockResolvedValue({
      id: 'row-11',
      status: 'FAILED',
      createdAt: new Date(),
      requestHash: hashOf('POST', '/api/v1/health/echo', {}),
    });
    prisma.idempotencyKey.updateMany.mockResolvedValue({ count: 1 });
    prisma.idempotencyKey.update.mockResolvedValue({});

    const context = makeContext({ headers: { 'idempotency-key': 'k11' } });
    const result$ = await interceptor.intercept(context, handler);
    const result = await firstValueFrom(result$);

    expect(result).toEqual({ echoed: true });
    expect(prisma.idempotencyKey.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: 'row-11', status: 'FAILED' }),
        data: expect.objectContaining({ status: 'IN_PROGRESS' }),
      }),
    );
  });

  it('refuses to retry a FAILED claim when the new payload differs - returns 409 without ever calling updateMany', async () => {
    prisma.idempotencyKey.create.mockRejectedValue(uniqueViolation());
    prisma.idempotencyKey.findUnique.mockResolvedValue({
      id: 'row-10',
      status: 'FAILED',
      createdAt: new Date(),
      requestHash: hashOf('POST', '/api/v1/health/echo', { hello: 'ORIGINAL' }),
    });
    const context = makeContext({
      headers: { 'idempotency-key': 'k10' },
      body: { hello: 'DIFFERENT' },
    });

    await expect(
      interceptor.intercept(context, handler),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(prisma.idempotencyKey.updateMany).not.toHaveBeenCalled();
  });

  it('loses the compare-and-swap takeover race to another concurrent takeover attempt, re-reads the row, and rejects instead of assuming it won', async () => {
    prisma.idempotencyKey.create.mockRejectedValue(uniqueViolation());
    const matchingHash = hashOf('POST', '/api/v1/health/echo', {});
    prisma.idempotencyKey.findUnique
      .mockResolvedValueOnce({
        id: 'row-8',
        status: 'IN_PROGRESS',
        createdAt: new Date(Date.now() - 60_000), // stale, eligible for takeover
        requestHash: matchingHash,
      })
      .mockResolvedValueOnce({
        id: 'row-8',
        status: 'IN_PROGRESS',
        createdAt: new Date(), // another request just won the CAS and re-claimed it
        requestHash: matchingHash,
      });
    prisma.idempotencyKey.updateMany.mockResolvedValue({ count: 0 });

    const context = makeContext({ headers: { 'idempotency-key': 'k8' } });

    await expect(
      interceptor.intercept(context, handler),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(prisma.idempotencyKey.updateMany).toHaveBeenCalledTimes(1);
  });

  it('scopes the claim to the acting user, so two different users can reuse the same client key', async () => {
    prisma.idempotencyKey.create.mockResolvedValue({ id: 'row-6' });
    prisma.idempotencyKey.update.mockResolvedValue({});

    const context = makeContext({
      headers: { 'idempotency-key': 'shared-key' },
      user: { id: 'user-42' },
    });
    await interceptor.intercept(context, handler);

    expect(prisma.idempotencyKey.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ scope: 'user-42' }),
      }),
    );
  });

  it('scopes a pre-auth request (no req.user - e.g. otp/verify) by its body phone+purpose, not a shared "anonymous"', async () => {
    prisma.idempotencyKey.create.mockResolvedValue({ id: 'row-preauth-1' });
    prisma.idempotencyKey.update.mockResolvedValue({});

    const context = makeContext({
      headers: { 'idempotency-key': 'shared-key' },
      body: { phone: '+970591111111', purpose: 'signup', otp_code: '123456' },
    });
    await interceptor.intercept(context, handler);

    const scope = prisma.idempotencyKey.create.mock.calls[0][0].data.scope;
    expect(scope).toMatch(/^phone:[a-f0-9]{64}$/);
    expect(scope).not.toBe('anonymous');
  });

  it('gives two different phones in the body different pre-auth scopes for the same client-chosen key', async () => {
    prisma.idempotencyKey.create.mockResolvedValue({ id: 'row-preauth-2' });
    prisma.idempotencyKey.update.mockResolvedValue({});

    const contextA = makeContext({
      headers: { 'idempotency-key': 'shared-key' },
      body: { phone: '+970591111111', purpose: 'signup' },
    });
    await interceptor.intercept(contextA, handler);
    const scopeA = prisma.idempotencyKey.create.mock.calls[0][0].data.scope;

    prisma.idempotencyKey.create.mockClear();
    const contextB = makeContext({
      headers: { 'idempotency-key': 'shared-key' },
      body: { phone: '+970592222222', purpose: 'signup' },
    });
    await interceptor.intercept(contextB, handler);
    const scopeB = prisma.idempotencyKey.create.mock.calls[0][0].data.scope;

    expect(scopeA).not.toBe(scopeB);
  });

  it('falls back to "anonymous" only when the body has no phone at all (no session, no identity to scope by)', async () => {
    prisma.idempotencyKey.create.mockResolvedValue({ id: 'row-preauth-3' });
    prisma.idempotencyKey.update.mockResolvedValue({});

    const context = makeContext({
      headers: { 'idempotency-key': 'k-no-phone' },
      body: { hello: 'world' },
    });
    await interceptor.intercept(context, handler);

    expect(prisma.idempotencyKey.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ scope: 'anonymous' }),
      }),
    );
  });

  it('marks the claim FAILED (not left IN_PROGRESS forever) if the handler throws', async () => {
    prisma.idempotencyKey.create.mockResolvedValue({ id: 'row-7' });
    prisma.idempotencyKey.update.mockResolvedValue({});
    const failingHandler: CallHandler = {
      handle: () => throwError(() => new Error('boom')),
    };

    const context = makeContext({ headers: { 'idempotency-key': 'k7' } });
    const result$ = await interceptor.intercept(context, failingHandler);

    await expect(firstValueFrom(result$)).rejects.toThrow('boom');
    expect(prisma.idempotencyKey.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'row-7' },
        data: { status: 'FAILED' },
      }),
    );
  });
});

// Mirrors the interceptor's own hashRequest() exactly, so the test can
// construct a matching/mismatching stored hash without importing a
// private function.
function hashOf(method: string, path: string, body: unknown): string {
  return createHash('sha256')
    .update(JSON.stringify({ method, path, body: body ?? null }))
    .digest('hex');
}
