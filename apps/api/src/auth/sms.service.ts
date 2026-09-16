import { Injectable, Logger } from '@nestjs/common';

/**
 * ⚠ OPEN-004: no SMS/OTP provider is selected yet. Per Part 1 D.4 and
 * .env.example's own documented contract, the API must fall back to a
 * logged/visible path whenever SMS_PROVIDER is unset - never pretend a
 * real message was sent. This is that fallback: it logs the code at
 * WARN level (visible via `docker compose logs api` / the hosting
 * platform's log viewer) instead of calling a provider. When OPEN-004
 * resolves, a real provider client goes here behind the same
 * `sendOtp()` interface, gated on SMS_PROVIDER being set - the callers
 * (OtpService) don't need to change.
 */
@Injectable()
export class SmsService {
  private readonly logger = new Logger(SmsService.name);

  async sendOtp(phone: string, code: string, expiresAt: Date): Promise<void> {
    if (process.env.SMS_PROVIDER) {
      throw new Error(
        `SMS_PROVIDER is set to "${process.env.SMS_PROVIDER}" but no real provider integration exists yet (OPEN-004) - refusing to silently fall back and claim delivery`,
      );
    }
    this.logger.warn(
      `[SMS-FALLBACK, OPEN-004] OTP for ${phone}: ${code} (expires ${expiresAt.toISOString()})`,
    );
  }
}
