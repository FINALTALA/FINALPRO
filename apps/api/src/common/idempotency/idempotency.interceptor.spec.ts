import {
  ConflictException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { CallHandler, ExecutionContext } from '@nestjs/common';
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
    };
  };
  let handler: CallHandler;

  beforeEach(() => {
    prisma = {
      idempotencyKey: {
        create: jest.fn(),
        findUnique: jest.fn(),
        update: jest.fn(),
      },
    };
    interceptor = new IdempotencyInterceptor(
      prisma as unknown as PrismaService,
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

  it('takes over a stale IN_PROGRESS claim (original owner crashed) instead of blocking forever', async () => {
    prisma.idempotencyKey.create.mockRejectedValue(uniqueViolation());
    prisma.idempotencyKey.findUnique.mockResolvedValue({
      id: 'row-5',
      status: 'IN_PROGRESS',
      createdAt: new Date(Date.now() - 60_000), // 60s old, past the 30s stale threshold
      requestHash: 'whatever',
    });
    prisma.idempotencyKey.update.mockResolvedValue({ id: 'row-5' });

    const context = makeContext({ headers: { 'idempotency-key': 'k5' } });
    const result$ = await interceptor.intercept(context, handler);
    const result = await firstValueFrom(result$);

    expect(result).toEqual({ echoed: true });
    expect(prisma.idempotencyKey.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'row-5' },
        data: expect.objectContaining({ status: 'IN_PROGRESS' }),
      }),
    );
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
