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
import { Prisma } from '../../generated/prisma/client';
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
  async verifyOtp(@Body() dto: OtpVerifyDto, @Req() req: Request) {
    // Guaranteed present: IdempotencyInterceptor already rejected the
    // request before this handler ran if it were missing.
    const idempotencyKey = req.header('Idempotency-Key')!;
    const purpose = toPrismaOtpPurpose(dto.purpose);
    const check = await this.otp.checkCode(dto.phone, purpose, dto.otp_code);
    if (!check.ok) {
      if (check.reason === 'invalid') {
        // Could be a genuinely wrong code, OR a retry (same
        // Idempotency-Key) after this exact code was already consumed
        // by an earlier attempt of THIS SAME request whose Redis token
        // and Postgres consumption both succeeded, but whose *separate*
        // idempotency-completion bookkeeping write then failed
        // (IdempotencyInterceptor's own COMPLETED/FAILED update is not
        // part of the same transaction as the handler's work).
        // checkCode() only ever looks at unconsumed rows, so it can't
        // tell those two cases apart on its own - recover the
        // already-issued token instead of failing a request that
        // actually already succeeded. Scoped to this exact
        // Idempotency-Key so a *different* concurrent request for the
        // same code (one that legitimately lost consume()'s atomic
        // race) can never recover someone else's token this way.
        const consumedRecord = await this.otp.findConsumedRecord(
          dto.phone,
          purpose,
          dto.otp_code,
          idempotencyKey,
        );
        if (consumedRecord) {
          const recoveredToken = await this.phoneVerification.recoverToken(
            consumedRecord.id,
          );
          if (recoveredToken) {
            return {
              session_token: recoveredToken,
              phone_verified_at: consumedRecord.consumedAt.toISOString(),
            };
          }
          // The OTP was consumed by this exact key, but its Redis-side
          // recovery index has itself expired (both share the same
          // 15-minute TTL as the token they're recovering - nothing to
          // separately clean up). The original token is gone the same
          // way it would be after 15 minutes regardless of this bug -
          // there's nothing left to hand back.
        }
      }
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

    const consumed = await this.otp.consume(check.claim!, { idempotencyKey });
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

    // Written only now, after confirming THIS request actually won the
    // consume() race - if it lost, there is nothing of this request's
    // own to index for recovery.
    await this.phoneVerification.createRecoveryIndex(check.claim!.id, token);

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
      sessionVersion: user.sessionVersion,
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
      sessionVersion: user.sessionVersion,
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

    // Only reachable with a real user - requestPasswordReset() never
    // issues a PASSWORD_RESET OTP for an unregistered phone, so a
    // valid, consumable claim implies the user exists.
    const existingUser = await this.prisma.user.findUniqueOrThrow({
      where: { phone: dto.phone },
    });
    const nextSessionVersion = existingUser.sessionVersion + 1;
    const passwordHash = await bcrypt.hash(dto.new_password, 10);

    // Prepare the new session BEFORE the transaction that actually
    // changes the password, stamped with the sessionVersion this reset
    // is *about to* produce. A session minted this way stays inert -
    // SessionAuthGuard's exact-version check rejects it - until the
    // transaction below genuinely commits that same version, so a
    // Redis hiccup here leaves Postgres completely untouched (same
    // "prepare the side artifact first, commit atomically last"
    // ordering as otp/verify), instead of stranding an
    // already-changed password with no way to report it.
    let token: string | null = null;
    try {
      await this.sessions.revokeAllForUser(existingUser.id);
      token = await this.sessions.create({
        userId: existingUser.id,
        phone: existingUser.phone,
        phoneVerifiedAt: existingUser.phoneVerifiedAt?.toISOString() ?? null,
        sessionVersion: nextSessionVersion,
      });
    } catch (err) {
      this.logger.error(
        `Password reset session preparation failed for phone ${dto.phone} before the password change - client should retry: ${(err as Error).message}`,
      );
    }
    const responseBody = { session_token: token };

    // OTP consumption, the password/sessionVersion update, the audit
    // record, AND this route's own Idempotency-Key completion record
    // are now all in ONE transaction - not just the first three. This
    // is what actually closes the "transaction commits, but the
    // interceptor's own separate bookkeeping write then fails" gap
    // (Sprint 2 review round 3's finding on this exact endpoint): if
    // any part fails, none of it commits, including the completion
    // record, so a retry can genuinely start over; if it all commits,
    // the completion record commits with it, so there is no longer a
    // window where the password changed but nothing durable and
    // replayable says so. IdempotencyInterceptor skips its own
    // post-handler write when it finds the record already COMPLETED
    // (see its intercept()) - this transaction beats it there.
    try {
      await this.prisma.$transaction(async (tx) => {
        const consumed = await this.otp.consume(check.claim!, {
          tx,
          idempotencyKey: req.header('Idempotency-Key')!,
        });
        if (!consumed) {
          // Lost the atomic-consume race to a different concurrent
          // reset-confirm for the same code - roll back (nothing to
          // undo yet) and report it as an invalid code below.
          throw new OtpConsumeRaceLostError();
        }

        await tx.user.update({
          where: { id: existingUser.id },
          data: { passwordHash, sessionVersion: { increment: 1 } },
        });
        await this.auditLog.record(
          {
            actorId: existingUser.id,
            correlationId: req.correlationId,
            action: 'user.password_reset',
            entityType: 'User',
            entityId: existingUser.id,
          },
          tx,
        );

        if (req.idempotencyClaimId) {
          await tx.idempotencyKey.update({
            where: { id: req.idempotencyClaimId },
            data: {
              status: 'COMPLETED',
              responseBody: responseBody as Prisma.InputJsonValue,
              responseCode: 200,
              completedAt: new Date(),
              expiresAt: new Date(Date.now() + OTP_VERIFY_IDEMPOTENCY_TTL_MS),
            },
          });
        }
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

    return responseBody;
  }
}
