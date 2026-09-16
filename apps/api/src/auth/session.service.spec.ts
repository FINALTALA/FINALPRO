import { SessionService } from './session.service';

function makeRedisMock() {
  const store = new Map<string, string>();
  const sets = new Map<string, Set<string>>();
  const multiOps: Array<() => void> = [];

  const multiChain = {
    set: jest.fn((key: string, value: string) => {
      multiOps.push(() => store.set(key, value));
      return multiChain;
    }),
    sadd: jest.fn((key: string, member: string) => {
      multiOps.push(() => {
        if (!sets.has(key)) sets.set(key, new Set());
        sets.get(key)!.add(member);
      });
      return multiChain;
    }),
    expire: jest.fn(() => multiChain),
    del: jest.fn((key: string) => {
      multiOps.push(() => {
        store.delete(key);
        sets.delete(key);
      });
      return multiChain;
    }),
    exec: jest.fn(async () => {
      multiOps.forEach((op) => op());
      multiOps.length = 0;
      return [];
    }),
  };

  return {
    multi: jest.fn(() => multiChain),
    get: jest.fn(async (key: string) => store.get(key) ?? null),
    smembers: jest.fn(async (key: string) => Array.from(sets.get(key) ?? [])),
    _store: store,
    _sets: sets,
  };
}

describe('SessionService', () => {
  it('creates a session that can be read back by its token', async () => {
    const redis = makeRedisMock();
    const service = new SessionService(redis as never);

    const token = await service.create({
      userId: 'user-1',
      phone: '+970000000001',
      phoneVerifiedAt: '2026-01-01T00:00:00.000Z',
      sessionVersion: 0,
    });

    expect(typeof token).toBe('string');
    expect(token.length).toBeGreaterThan(20);

    const session = await service.get(token);
    expect(session).toEqual({
      userId: 'user-1',
      phone: '+970000000001',
      phoneVerifiedAt: '2026-01-01T00:00:00.000Z',
      sessionVersion: 0,
    });
  });

  it('returns null for a token that was never issued', async () => {
    const redis = makeRedisMock();
    const service = new SessionService(redis as never);

    expect(await service.get('nonexistent-token')).toBeNull();
  });

  it('issues a different token each time, even for the same user', async () => {
    const redis = makeRedisMock();
    const service = new SessionService(redis as never);
    const data = {
      userId: 'user-2',
      phone: '+970000000002',
      phoneVerifiedAt: null,
      sessionVersion: 0,
    };

    const tokenA = await service.create(data);
    const tokenB = await service.create(data);

    expect(tokenA).not.toBe(tokenB);
  });

  it('revokeAllForUser invalidates every session issued for that user, and no others', async () => {
    const redis = makeRedisMock();
    const service = new SessionService(redis as never);

    const tokenA = await service.create({
      userId: 'user-3',
      phone: '+970000000003',
      phoneVerifiedAt: null,
      sessionVersion: 0,
    });
    const tokenB = await service.create({
      userId: 'user-3',
      phone: '+970000000003',
      phoneVerifiedAt: null,
      sessionVersion: 0,
    });
    const otherUserToken = await service.create({
      userId: 'user-4',
      phone: '+970000000004',
      phoneVerifiedAt: null,
      sessionVersion: 0,
    });

    await service.revokeAllForUser('user-3');

    expect(await service.get(tokenA)).toBeNull();
    expect(await service.get(tokenB)).toBeNull();
    expect(await service.get(otherUserToken)).not.toBeNull();
  });

  it('revokeAllForUser on a user with no sessions is a no-op, not an error', async () => {
    const redis = makeRedisMock();
    const service = new SessionService(redis as never);

    await expect(
      service.revokeAllForUser('never-logged-in'),
    ).resolves.not.toThrow();
  });
});
