import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  HttpCode,
  HttpException,
  HttpStatus,
  Logger,
  Post,
  Req,
  UseInterceptors,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import * as bcrypt from 'bcryptjs';
import { Request } from 'express';
import { AuditLogService } from '../audit/audit-log.service';
import { IdempotencyInterceptor } from '../common/idempotency/idempotency.interceptor';
import { IdempotencyTtl } from '../common/idempotency/idempotency-ttl.decorator';
import { PrismaService } from '../prisma/prisma.service';
import { LoginDto } from './dto/login.dto';
import { OtpRequestDto } from './dto/otp-request.dto';
import { OtpVerifyDto } from './dto/otp-verify.dto';
import { PasswordResetConfirmDto } from './dto/password-reset-confirm.dto';
import { PasswordResetRequestDto } from './dto/password-reset-request.dto';
import { RegisterDto } from './dto/register.dto';
import { OtpCheckResult, OtpService } from './otp.service';
import { toPrismaOtpPurpose } from './otp-purpose.util';
import { PhoneVerificationService } from './phone-verification.service';
import { SessionService } from './session.service';

const OTP_VERIFY_IDEMPOTENCY_TTL_MS = 5 * 60 * 1000; // Part 4, H.3's "short window (e.g. 5 minutes)"

/** Throws the exact {status, code} pair Part 4, H.3 documents for an OTP failure. */
function throwForOtpFailure(reason: OtpCheckResult['reason']): never {
  switch (reason) {
    case 'expired':
      throw new ConflictException({
        code: 'OTP_EXPIRED',
        message: 'This OTP code has expired',
      });
    case 'too_many_attempts':
      throw new HttpException(
        {
          code: 'TOO_MANY_ATTEMPTS',
          message: 'Too many incorrect attempts for this OTP code',
        },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    case 'invalid':
    default:
      throw new BadRequestException({
        code: 'OTP_INVALID',
        message: 'This OTP code is invalid',
      });
  }
}

/** Thrown inside confirmPasswordReset's transaction when consume() loses the atomic race - never reaches a caller. */
class OtpConsumeRaceLostError extends Error {}

@Controller('auth')
export class AuthController {
  private readonly logger = new Logger(AuthController.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly otp: OtpService,
    private readonly sessions: SessionService,
    private readonly phoneVerification: PhoneVerificationService,
    private readonly auditLog: AuditLogService,
  ) {}

  // FR-AUTH-011: auth/OTP endpoints get a materially stricter limit
  // than the 100/min global default (app.module.ts).
  @Post('otp/request')
  @HttpCode(202)
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  async requestOtp(@Body() dto: OtpRequestDto) {
    const purpose = toPrismaOtpPurpose(dto.purpose);

    if (purpose === 'PASSWORD_RESET') {
      // Anti-enumeration: only issue a real code for a phone that's
      // actually registered, but always return the same response
      // shape either way so the response itself can't be used to probe
      // which phones exist.
      const user = await this.prisma.user.findUnique({
        where: { phone: dto.phone },
      });
      if (user) {
        await this.otp.issue(dto.phone, purpose);
      }
    } else {
      await this.otp.issue(dto.phone, purpose);
    }

    return { expires_in_seconds: 300 };
  }

  @Post('otp/verify')
  @HttpCode(200)
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @IdempotencyTtl(OTP_VERIFY_IDEMPOTENCY_TTL_MS)
  @UseInterceptors(IdempotencyInterceptor)
  async verifyOtp(@Body() dto: OtpVerifyDto) {
    const purpose = toPrismaOtpPurpose(dto.purpose);
    const check = await this.otp.checkCode(dto.phone, purpose, dto.otp_code);
    if (!check.ok) {
      throwForOtpFailure(check.reason);
    }

    // Create the Redis verification token BEFORE consuming the OTP in
    // Postgres. If Redis is what fails, nothing in Postgres has
    // changed yet, so an identical retry (same Idempotency-Key, same
    // code) finds the OTP still unconsumed and can complete cleanly -
    // consuming first and creating the token second would burn the
    // OTP on a Redis hiccup with no way for a retry to recover it.
    const phoneVerifiedAt = new Date();
    const token = await this.phoneVerification.create({
      phone: dto.phone,
      purpose,
    });

    const consumed = await this.otp.consume(check.claim!);
    if (!consumed) {
      // Lost the atomic-consume race to a different concurrent verify
      // for the same code (a different Idempotency-Key - the
      // interceptor's own claim only protects against a *repeated*
      // key). That request wins; this one's already-created token is
      // simply never returned and expires unused.
      throw new BadRequestException({
        code: 'OTP_INVALID',
        message: 'This OTP code is invalid',
      });
    }

    return {
      session_token: token,
      phone_verified_at: phoneVerifiedAt.toISOString(),
    };
  }

  @Post('register')
  @HttpCode(201)
  async register(@Body() dto: RegisterDto, @Req() req: Request) {
    const verification = await this.phoneVerification.consume(
      dto.verification_token,
    );
    if (
      !verification ||
      verification.phone !== dto.phone ||
      verification.purpose !== 'SIGNUP'
    ) {
      throw new BadRequestException({
        code: 'PHONE_NOT_VERIFIED',
        message:
          'This phone number has not been OTP-verified for signup, or the verification has expired',
      });
    }

    const existing = await this.prisma.user.findUnique({
      where: { phone: dto.phone },
    });
    if (existing) {
      throw new ConflictException({
        code: 'PHONE_ALREADY_REGISTERED',
        message: 'An account with this phone number already exists',
      });
    }

    const passwordHash = await bcrypt.hash(dto.password, 10);
    const user = await this.prisma.$transaction(async (tx) => {
      const created = await tx.user.create({
        data: {
          phone: dto.phone,
          passwordHash,
          phoneVerifiedAt: new Date(),
        },
      });
      await tx.customerProfile.create({ data: { userId: created.id } });
      await this.auditLog.record(
        {
          correlationId: req.correlationId,
          action: 'user.registered',
          entityType: 'User',
          entityId: created.id,
        },
        tx,
      );
      return created;
    });

    const token = await this.sessions.create({
      userId: user.id,
      phone: user.phone,
      phoneVerifiedAt: user.phoneVerifiedAt?.toISOString() ?? null,
    });

    return {
      session_token: token,
      user: {
        id: user.id,
        phone: user.phone,
        phone_verified_at: user.phoneVerifiedAt?.toISOString() ?? null,
      },
    };
  }

  @Post('login')
  @HttpCode(200)
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  async login(@Body() dto: LoginDto, @Req() req: Request) {
    const user = await this.prisma.user.findUnique({
      where: { phone: dto.phone },
    });
    const passwordMatches = user
      ? await bcrypt.compare(dto.password, user.passwordHash)
      : false;

    if (!user || !passwordMatches) {
      // Same message/code whether the phone is unregistered or the
      // password is wrong - doesn't reveal which one.
      throw new BadRequestException({
        code: 'INVALID_CREDENTIALS',
        message: 'Phone number or password is incorrect',
      });
    }

    const token = await this.sessions.create({
      userId: user.id,
      phone: user.phone,
      phoneVerifiedAt: user.phoneVerifiedAt?.toISOString() ?? null,
    });

    await this.auditLog.record({
      actorId: user.id,
      correlationId: req.correlationId,
      action: 'user.login',
      entityType: 'User',
      entityId: user.id,
    });

    return { session_token: token };
  }

  @Post('password/reset-request')
  @HttpCode(202)
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  async requestPasswordReset(@Body() dto: PasswordResetRequestDto) {
    const user = await this.prisma.user.findUnique({
      where: { phone: dto.phone },
    });
    if (user) {
      await this.otp.issue(dto.phone, 'PASSWORD_RESET');
    }
    // Same response regardless, per the anti-enumeration note above.
    return { expires_in_seconds: 300 };
  }

  @Post('password/reset-confirm')
  @HttpCode(200)
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @IdempotencyTtl(OTP_VERIFY_IDEMPOTENCY_TTL_MS)
  @UseInterceptors(IdempotencyInterceptor)
  async confirmPasswordReset(
    @Body() dto: PasswordResetConfirmDto,
    @Req() req: Request,
  ) {
    const check = await this.otp.checkCode(
      dto.phone,
      'PASSWORD_RESET',
      dto.otp_code,
    );
    if (!check.ok) {
      throwForOtpFailure(check.reason);
    }

    // OTP consumption, the password update, and the audit record all
    // happen in ONE transaction: if any part fails, none of it commits
    // - the OTP stays unconsumed and an identical retry can genuinely
    // start over, instead of finding a burned OTP with no completed
    // password change to show for it.
    const passwordHash = await bcrypt.hash(dto.new_password, 10);
    let user: { id: string; phone: string; phoneVerifiedAt: Date | null };
    try {
      user = await this.prisma.$transaction(async (tx) => {
        const consumed = await this.otp.consume(check.claim!, tx);
        if (!consumed) {
          // Lost the atomic-consume race to a different concurrent
          // reset-confirm for the same code - roll back (nothing to
          // undo yet) and report it as an invalid code below.
          throw new OtpConsumeRaceLostError();
        }

        // Only reachable with a real user - requestPasswordReset()
        // never issues a PASSWORD_RESET OTP for an unregistered phone,
        // so a valid, consumable claim implies the user exists.
        const existing = await tx.user.findUniqueOrThrow({
          where: { phone: dto.phone },
        });
        const updated = await tx.user.update({
          where: { id: existing.id },
          data: { passwordHash },
        });
        await this.auditLog.record(
          {
            actorId: updated.id,
            correlationId: req.correlationId,
            action: 'user.password_reset',
            entityType: 'User',
            entityId: updated.id,
          },
          tx,
        );
        return updated;
      });
    } catch (err) {
      if (err instanceof OtpConsumeRaceLostError) {
        throw new BadRequestException({
          code: 'OTP_INVALID',
          message: 'This OTP code is invalid',
        });
      }
      throw err;
    }

    // The password change above is already durably committed - from
    // here on, a hiccup must degrade gracefully rather than fail the
    // request. Throwing here would mark this Idempotency-Key FAILED
    // and make a same-key retry re-attempt OTP consumption, which can
    // now only ever fail since the OTP was already, correctly,
    // consumed above. Security best practice (revoking other sessions)
    // and issuing a fresh one are both best-effort on top of the
    // guaranteed core change, not a condition of its success.
    let token: string | null = null;
    try {
      await this.sessions.revokeAllForUser(user.id);
      token = await this.sessions.create({
        userId: user.id,
        phone: user.phone,
        phoneVerifiedAt: user.phoneVerifiedAt?.toISOString() ?? null,
      });
    } catch (err) {
      this.logger.error(
        `Password reset for user ${user.id} committed, but session housekeeping failed - client should log in again: ${(err as Error).message}`,
      );
    }

    return { session_token: token };
  }
}
