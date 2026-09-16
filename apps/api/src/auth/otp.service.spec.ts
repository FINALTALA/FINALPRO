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

  describe('verify', () => {
    it('fails with "invalid" when no OTP exists for this phone/purpose', async () => {
      prisma.otpCode.findFirst.mockResolvedValue(null);

      const result = await service.verify('+970000000001', 'SIGNUP', '123456');

      expect(result).toEqual({ ok: false, reason: 'invalid' });
    });

    it('succeeds and consumes the OTP on a matching code', async () => {
      prisma.otpCode.findFirst.mockResolvedValue({
        id: 'otp-1',
        codeHash: hashOf('654321'),
        attemptCount: 0,
        expiresAt: new Date(Date.now() + 60_000),
      });
      prisma.otpCode.update.mockResolvedValue({});

      const result = await service.verify('+970000000001', 'SIGNUP', '654321');

      expect(result).toEqual({ ok: true });
      expect(prisma.otpCode.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'otp-1' },
          data: expect.objectContaining({ consumedAt: expect.any(Date) }),
        }),
      );
    });

    it('fails with "invalid" and increments attemptCount on a wrong code, without consuming it', async () => {
      prisma.otpCode.findFirst.mockResolvedValue({
        id: 'otp-2',
        codeHash: hashOf('654321'),
        attemptCount: 1,
        expiresAt: new Date(Date.now() + 60_000),
      });
      prisma.otpCode.update.mockResolvedValue({});

      const result = await service.verify('+970000000001', 'SIGNUP', '000000');

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

      const result = await service.verify('+970000000001', 'SIGNUP', '654321');

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

      const result = await service.verify('+970000000001', 'SIGNUP', '654321');

      expect(result).toEqual({ ok: false, reason: 'too_many_attempts' });
      expect(prisma.otpCode.update).not.toHaveBeenCalled();
    });
  });
});
