import { createHash } from 'crypto';
import { OtpService } from './otp.service';
import { SmsService } from './sms.service';

function hashOf(code: string): string {
  return createHash('sha256').update(code).digest('hex');
}

describe('OtpService', () => {
  let prisma: {
    otpCode: {
      create: jest.Mock;
      findFirst: jest.Mock;
      update: jest.Mock;
      updateMany: jest.Mock;
    };
  };
  let sms: { sendOtp: jest.Mock };
  let service: OtpService;

  beforeEach(() => {
    prisma = {
      otpCode: {
        create: jest.fn(),
        findFirst: jest.fn(),
        update: jest.fn(),
        updateMany: jest.fn(),
      },
    };
    sms = { sendOtp: jest.fn().mockResolvedValue(undefined) };
    service = new OtpService(prisma as never, sms as unknown as SmsService);
  });

  describe('issue', () => {
    it('stores a hashed code (never the plaintext) and sends it via SmsService', async () => {
      prisma.otpCode.create.mockResolvedValue({});

      await service.issue('+970000000001', 'SIGNUP');

      expect(prisma.otpCode.create).toHaveBeenCalledTimes(1);
      const data = prisma.otpCode.create.mock.calls[0][0].data;
      expect(data.phone).toBe('+970000000001');
      expect(data.purpose).toBe('SIGNUP');
      expect(data.codeHash).toMatch(/^[a-f0-9]{64}$/); // sha256 hex, not a 6-digit code

      expect(sms.sendOtp).toHaveBeenCalledTimes(1);
      const [phone, code] = sms.sendOtp.mock.calls[0];
      expect(phone).toBe('+970000000001');
      expect(code).toMatch(/^\d{6}$/);
      expect(data.codeHash).toBe(hashOf(code));
    });
  });

  describe('checkCode', () => {
    it('fails with "invalid" when no OTP exists for this phone/purpose', async () => {
      prisma.otpCode.findFirst.mockResolvedValue(null);

      const result = await service.checkCode(
        '+970000000001',
        'SIGNUP',
        '123456',
      );

      expect(result).toEqual({ ok: false, reason: 'invalid' });
    });

    it('succeeds and returns a claim on a matching code, without consuming it', async () => {
      const expiresAt = new Date(Date.now() + 60_000);
      prisma.otpCode.findFirst.mockResolvedValue({
        id: 'otp-1',
        codeHash: hashOf('654321'),
        attemptCount: 0,
        expiresAt,
      });

      const result = await service.checkCode(
        '+970000000001',
        'SIGNUP',
        '654321',
      );

      expect(result).toEqual({
        ok: true,
        claim: { id: 'otp-1', expiresAt, attemptCount: 0 },
      });
      expect(prisma.otpCode.update).not.toHaveBeenCalled();
      expect(prisma.otpCode.updateMany).not.toHaveBeenCalled();
    });

    it('fails with "invalid" and increments attemptCount on a wrong code, without returning a claim', async () => {
      prisma.otpCode.findFirst.mockResolvedValue({
        id: 'otp-2',
        codeHash: hashOf('654321'),
        attemptCount: 1,
        expiresAt: new Date(Date.now() + 60_000),
      });
      prisma.otpCode.update.mockResolvedValue({});

      const result = await service.checkCode(
        '+970000000001',
        'SIGNUP',
        '000000',
      );

      expect(result).toEqual({ ok: false, reason: 'invalid' });
      expect(prisma.otpCode.update).toHaveBeenCalledWith({
        where: { id: 'otp-2' },
        data: { attemptCount: { increment: 1 } },
      });
    });

    it('fails with "expired" for a code past its expiry, even if correct', async () => {
      prisma.otpCode.findFirst.mockResolvedValue({
        id: 'otp-3',
        codeHash: hashOf('654321'),
        attemptCount: 0,
        expiresAt: new Date(Date.now() - 1_000),
      });

      const result = await service.checkCode(
        '+970000000001',
        'SIGNUP',
        '654321',
      );

      expect(result).toEqual({ ok: false, reason: 'expired' });
      expect(prisma.otpCode.update).not.toHaveBeenCalled();
    });

    it('fails with "too_many_attempts" once attemptCount has hit the cap, without checking the code', async () => {
      prisma.otpCode.findFirst.mockResolvedValue({
        id: 'otp-4',
        codeHash: hashOf('654321'),
        attemptCount: 5,
        expiresAt: new Date(Date.now() + 60_000),
      });

      const result = await service.checkCode(
        '+970000000001',
        'SIGNUP',
        '654321',
      );

      expect(result).toEqual({ ok: false, reason: 'too_many_attempts' });
      expect(prisma.otpCode.update).not.toHaveBeenCalled();
    });
  });

  describe('consume', () => {
    it('atomically consumes a claim, pinning id/attemptCount and requiring expiresAt to still be in the future', async () => {
      const expiresAt = new Date(Date.now() + 60_000);
      prisma.otpCode.updateMany.mockResolvedValue({ count: 1 });

      const consumed = await service.consume({
        id: 'otp-5',
        expiresAt,
        attemptCount: 0,
      });

      expect(consumed).toBe(true);
      expect(prisma.otpCode.updateMany).toHaveBeenCalledWith({
        where: {
          id: 'otp-5',
          consumedAt: null,
          expiresAt: { gt: expect.any(Date) },
          attemptCount: 0,
        },
        data: { consumedAt: expect.any(Date), consumedByKey: undefined },
      });
    });

    it('returns false when the compare-and-swap loses the race (count 0) - already consumed by someone else', async () => {
      prisma.otpCode.updateMany.mockResolvedValue({ count: 0 });

      const consumed = await service.consume({
        id: 'otp-6',
        expiresAt: new Date(Date.now() + 60_000),
        attemptCount: 0,
      });

      expect(consumed).toBe(false);
    });

    it("returns false for a claim that was still valid at checkCode() time but has since expired (the TOCTOU boundary) - even though the CAS's other pinned fields still match", async () => {
      // The real enforcement is Postgres evaluating `expiresAt: { gt: now }`
      // against the CURRENT row at the moment the UPDATE runs, which a
      // mocked Prisma client can't itself prove - this locks in that
      // consume() asks for that check on every call, rather than
      // silently reverting to an exact-equality pin that would let a
      // now-expired code still be consumed as long as nothing else
      // touched the row. See the e2e boundary test for the real-DB proof.
      prisma.otpCode.updateMany.mockResolvedValue({ count: 0 });

      const consumed = await service.consume({
        id: 'otp-boundary',
        expiresAt: new Date(Date.now() - 1), // was valid when checked, expired by the time we got here
        attemptCount: 0,
      });

      expect(consumed).toBe(false);
      expect(prisma.otpCode.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            expiresAt: { gt: expect.any(Date) },
          }),
        }),
      );
    });

    it('persists the consuming Idempotency-Key alongside consumedAt when given', async () => {
      prisma.otpCode.updateMany.mockResolvedValue({ count: 1 });

      await service.consume(
        {
          id: 'otp-token',
          expiresAt: new Date(Date.now() + 60_000),
          attemptCount: 0,
        },
        { idempotencyKey: 'the-key' },
      );

      expect(prisma.otpCode.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ consumedByKey: 'the-key' }),
        }),
      );
    });

    it('uses the provided transaction client instead of the default one when given', async () => {
      const tx = {
        otpCode: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
      };

      await service.consume(
        {
          id: 'otp-7',
          expiresAt: new Date(Date.now() + 60_000),
          attemptCount: 0,
        },
        { tx: tx as never },
      );

      expect(tx.otpCode.updateMany).toHaveBeenCalled();
      expect(prisma.otpCode.updateMany).not.toHaveBeenCalled();
    });
  });

  describe('findConsumedRecord', () => {
    it('returns the id and consumedAt for a consumed row matching the code hash AND the exact Idempotency-Key', async () => {
      const consumedAt = new Date(Date.now() - 1_000);
      prisma.otpCode.findFirst.mockResolvedValue({
        id: 'otp-consumed-1',
        codeHash: hashOf('654321'),
        consumedByKey: 'my-retry-key',
        consumedAt,
      });

      const result = await service.findConsumedRecord(
        '+970000000001',
        'SIGNUP',
        '654321',
        'my-retry-key',
      );

      expect(result).toEqual({ id: 'otp-consumed-1', consumedAt });
    });

    it('returns null when no matching consumed row exists', async () => {
      prisma.otpCode.findFirst.mockResolvedValue(null);

      const result = await service.findConsumedRecord(
        '+970000000001',
        'SIGNUP',
        '654321',
        'my-retry-key',
      );

      expect(result).toBeNull();
    });

    it('queries only consumed rows matched by code hash AND the exact Idempotency-Key - not a different concurrent request for the same code', async () => {
      prisma.otpCode.findFirst.mockResolvedValue(null);

      await service.findConsumedRecord(
        '+970000000001',
        'SIGNUP',
        '654321',
        'my-retry-key',
      );

      expect(prisma.otpCode.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            phone: '+970000000001',
            purpose: 'SIGNUP',
            codeHash: hashOf('654321'),
            consumedByKey: 'my-retry-key',
            consumedAt: { not: null },
          }),
        }),
      );
    });
  });
});
