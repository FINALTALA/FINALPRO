import { PhoneVerificationService } from './phone-verification.service';

function makeRedisMock() {
  const store = new Map<string, string>();
  return {
    set: jest.fn(async (key: string, value: string) => {
      store.set(key, value);
      return 'OK';
    }),
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
});
