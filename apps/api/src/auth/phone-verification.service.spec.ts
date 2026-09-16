import { PhoneVerificationService } from './phone-verification.service';

function makeRedisMock() {
  const store = new Map<string, string>();
  return {
    set: jest.fn(async (key: string, value: string) => {
      store.set(key, value);
      return 'OK';
    }),
    get: jest.fn(async (key: string) => store.get(key) ?? null),
    getdel: jest.fn(async (key: string) => {
      const value = store.get(key);
      store.delete(key);
      return value ?? null;
    }),
  };
}

describe('PhoneVerificationService', () => {
  it('creates a token that can be consumed exactly once', async () => {
    const redis = makeRedisMock();
    const service = new PhoneVerificationService(redis as never);

    const token = await service.create({
      phone: '+970000000001',
      purpose: 'SIGNUP',
    });

    const first = await service.consume(token);
    expect(first).toEqual({ phone: '+970000000001', purpose: 'SIGNUP' });

    const second = await service.consume(token);
    expect(second).toBeNull();
  });

  it('returns null for a token that was never issued', async () => {
    const redis = makeRedisMock();
    const service = new PhoneVerificationService(redis as never);

    expect(await service.consume('bogus-token')).toBeNull();
  });

  describe('recovery index', () => {
    it('recovers a token by the OTP id AND the exact Idempotency-Key it was indexed under', async () => {
      const redis = makeRedisMock();
      const service = new PhoneVerificationService(redis as never);

      await service.createRecoveryIndex('otp-1', 'my-key', 'tok_abc123');

      expect(await service.recoverToken('otp-1', 'my-key')).toBe('tok_abc123');
    });

    it('returns null for an OTP id with no recovery index', async () => {
      const redis = makeRedisMock();
      const service = new PhoneVerificationService(redis as never);

      expect(await service.recoverToken('never-indexed', 'my-key')).toBeNull();
    });

    it('returns null for the right OTP id but the wrong Idempotency-Key - a different concurrent request can never recover this one', async () => {
      const redis = makeRedisMock();
      const service = new PhoneVerificationService(redis as never);

      await service.createRecoveryIndex('otp-1', 'winner-key', 'tok_abc123');

      expect(await service.recoverToken('otp-1', 'loser-key')).toBeNull();
    });

    it('keeps two concurrent requests for the same OTP id fully isolated - each Idempotency-Key gets its own entry, neither overwrites the other', async () => {
      const redis = makeRedisMock();
      const service = new PhoneVerificationService(redis as never);

      await service.createRecoveryIndex('otp-1', 'key-a', 'tok_a');
      await service.createRecoveryIndex('otp-1', 'key-b', 'tok_b');

      expect(await service.recoverToken('otp-1', 'key-a')).toBe('tok_a');
      expect(await service.recoverToken('otp-1', 'key-b')).toBe('tok_b');
    });

    it('is a separate entry from the main token - consuming the main token does not remove the recovery index', async () => {
      const redis = makeRedisMock();
      const service = new PhoneVerificationService(redis as never);

      const token = await service.create({
        phone: '+970000000001',
        purpose: 'SIGNUP',
      });
      await service.createRecoveryIndex('otp-2', 'my-key', token);

      await service.consume(token);

      expect(await service.recoverToken('otp-2', 'my-key')).toBe(token);
    });
  });
});
