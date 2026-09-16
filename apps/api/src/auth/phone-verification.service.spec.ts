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
    it('recovers a token by the OTP id it was indexed under', async () => {
      const redis = makeRedisMock();
      const service = new PhoneVerificationService(redis as never);

      await service.createRecoveryIndex('otp-1', 'tok_abc123');

      expect(await service.recoverToken('otp-1')).toBe('tok_abc123');
    });

    it('returns null for an OTP id with no recovery index', async () => {
      const redis = makeRedisMock();
      const service = new PhoneVerificationService(redis as never);

      expect(await service.recoverToken('never-indexed')).toBeNull();
    });

    it('is a separate entry from the main token - consuming the main token does not remove the recovery index', async () => {
      const redis = makeRedisMock();
      const service = new PhoneVerificationService(redis as never);

      const token = await service.create({
        phone: '+970000000001',
        purpose: 'SIGNUP',
      });
      await service.createRecoveryIndex('otp-2', token);

      await service.consume(token);

      expect(await service.recoverToken('otp-2')).toBe(token);
    });
  });
});
