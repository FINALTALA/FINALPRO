import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  ForbiddenException,
  HttpCode,
  HttpException,
  HttpStatus,
  Logger,
  NotFoundException,
  Post,
  Req,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import * as bcrypt from 'bcryptjs';
import { Request } from 'express';
import { AuditLogService } from '../audit/audit-log.service';
import { IdempotencyCompletionService } from '../common/idempotency/idempotency-completion.service';
import { IdempotencyInterceptor } from '../common/idempotency/idempotency.interceptor';
import { IdempotencyTtl } from '../common/idempotency/idempotency-ttl.decorator';
import { Prisma } from '../../generated/prisma/client';
import { CurrentUser } from './current-user.decorator';
import { AuthenticatedUser, SessionAuthGuard } from './session-auth.guard';
import { PrismaService } from '../prisma/prisma.service';
import { LoginDto } from './dto/login.dto';
import { OtpRequestDto } from './dto/otp-request.dto';
import { OtpVerifyDto } from './dto/otp-verify.dto';
import { PasswordResetConfirmDto } from './dto/password-reset-confirm.dto';
import { PasswordResetRequestDto } from './dto/password-reset-request.dto';
import { RegisterDto } from './dto/register.dto';
import { StaffInviteAcceptDto } from './dto/staff-invite-accept.dto';
import { OtpCheckResult, OtpService } from './otp.service';
import { toPrismaOtpPurpose } from './otp-purpose.util';
import { PhoneVerificationService } from './phone-verification.service';
import { SessionService } from './session.service';

const OTP_VERIFY_IDEMPOTENCY_TTL_MS = 5 * 60 * 1000; // Part 4, H.3's "short window (e.g. 5 minutes)"

/**
 * confirmPasswordReset's explicit, always-replayable "core operation
 * succeeded, session issuance is separate" response (Sprint 2 review
 * round 6). Written into the Idempotency-Key completion record by the
 * password-changing transaction itself - a caller who only ever sees
 * this value (a genuine Redis outage during session issuance, or a
 * replay of one) still gets a clear, honest 200: the password change
 * is final and already happened; log in with it directly.
 */
const LOGIN_REQUIRED_RESPONSE = {
  session_token: null,
  session_status: 'LOGIN_REQUIRED',
  password_reset_completed: true,
} as const;

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
    private readonly idempotencyCompletion: IdempotencyCompletionService,
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
    } else if (purpose === 'STAFF_INVITE') {
      // Same anti-abuse shape as PASSWORD_RESET above (Sprint 4,
      // RB-ROLE-002): only issue a real code when a genuine, still-
      // pending, not-yet-expired StaffInvite exists for this phone -
      // otherwise anyone could make this endpoint SMS an arbitrary
      // phone number by claiming purpose=staff_invite with nothing
      // real behind it.
      const invite = await this.prisma.staffInvite.findFirst({
        where: {
          phone: dto.phone,
          status: 'PENDING',
          expiresAt: { gt: new Date() },
        },
      });
      if (invite) {
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
            idempotencyKey,
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

    // Create the Redis verification token, AND its recovery index,
    // BEFORE consuming the OTP in Postgres (Sprint 2 review round 5 -
    // a prior version of this fix created the recovery index *after*
    // consume(), which reopened the exact gap it was meant to close:
    // if THAT write failed, the OTP was already consumed with no index
    // for a retry to recover). If Redis is what fails at either of
    // these two steps, nothing in Postgres has changed yet, so an
    // identical retry (same Idempotency-Key, same code) finds the OTP
    // still unconsumed and can complete cleanly.
    //
    // A request that goes on to *lose* the consume() race below still
    // wrote a recovery-index entry for a token nobody will ever
    // receive - harmless: that entry is keyed by this request's own
    // Idempotency-Key, and findConsumedRecord()'s exact consumedByKey
    // match means only the *winner's* key can ever look up the row
    // that's actually recorded as consumed. The loser's entry and
    // token simply expire unused.
    const phoneVerifiedAt = new Date();
    const token = await this.phoneVerification.create({
      phone: dto.phone,
      purpose,
    });
    await this.phoneVerification.createRecoveryIndex(
      check.claim!.id,
      idempotencyKey,
      token,
    );

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

  // Sprint 14: server-side logout. Revokes ONLY the calling session
  // (the bearer token SessionAuthGuard just validated) - never another
  // session, never another user's. The token comes from this same
  // request's own header, so there is no id anyone could substitute.
  @Post('logout')
  @HttpCode(200)
  @UseGuards(SessionAuthGuard)
  async logout(@CurrentUser() user: AuthenticatedUser, @Req() req: Request) {
    const header = req.header('Authorization') ?? '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : '';
    await this.sessions.revoke(token, user.id);
    await this.auditLog.record({
      actorId: user.id,
      correlationId: req.correlationId,
      action: 'user.logout',
      entityType: 'User',
      entityId: user.id,
    });
    return { logged_out: true };
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
    const passwordHash = await bcrypt.hash(dto.new_password, 10);
    const idempotencyKey = req.header('Idempotency-Key')!;

    // Nothing touches Redis before or during this transaction (Sprint
    // 2 review round 5 - a prior version prepared/revoked sessions
    // *before* this point, using a *predicted* post-increment
    // sessionVersion; both were wrong. A failed OTP consumption or any
    // other transaction failure would already have revoked the user's
    // other sessions with no password change to show for it - and the
    // prediction itself was unsafe under two concurrent resets for the
    // same user).
    //
    // OTP consumption, the password/sessionVersion update, the audit
    // record, AND this route's own Idempotency-Key completion record
    // are all in ONE transaction (Sprint 2 review round 3/4): if any
    // part fails, none of it commits, so a retry can genuinely start
    // over; if it all commits, the password reset is final - by
    // explicit product decision (Sprint 2 review round 6), Redis is
    // never allowed to roll it back or gate it. session_token is
    // necessarily null at this point - Redis can't participate in this
    // transaction, and the real sessionVersion a valid session needs
    // is only known once this transaction actually commits, not
    // before - but session_status: LOGIN_REQUIRED and
    // password_reset_completed: true are both unconditionally true the
    // moment this commits, and stay true for every future replay of
    // this exact request.
    let updatedUser: {
      id: string;
      phone: string;
      phoneVerifiedAt: Date | null;
      sessionVersion: number;
    };
    try {
      updatedUser = await this.prisma.$transaction(async (tx) => {
        const consumed = await this.otp.consume(check.claim!, {
          tx,
          idempotencyKey,
        });
        if (!consumed) {
          // Lost the atomic-consume race to a different concurrent
          // reset-confirm for the same code - roll back (nothing to
          // undo yet) and report it as an invalid code below.
          throw new OtpConsumeRaceLostError();
        }

        const updated = await tx.user.update({
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
              responseBody: LOGIN_REQUIRED_RESPONSE as Prisma.InputJsonValue,
              responseCode: 200,
              completedAt: new Date(),
              expiresAt: new Date(Date.now() + OTP_VERIFY_IDEMPOTENCY_TTL_MS),
            },
          });
        }

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

    // The password change is final and already durably committed,
    // using the REAL, authoritative sessionVersion the transaction
    // actually produced - never a pre-transaction prediction. Session
    // issuance from here on is a pure enhancement on top of that
    // already-successful outcome, never a condition of it: if Redis is
    // unreachable, this request still reports success -
    // session_status: LOGIN_REQUIRED, the exact same response the
    // transaction above already durably recorded - rather than a
    // misleading 500 for an operation that, in truth, already
    // succeeded. Revoking old sessions is now purely an optimization
    // (SessionAuthGuard's sessionVersion check already makes them
    // unusable the instant the transaction above committed).
    // ISSUED is only ever returned to *this* caller once it's also
    // durably recorded as this exact Idempotency-Key's completed
    // response (Sprint 2 review round 7) - otherwise a same-key retry
    // would replay the transaction's still-LOGIN_REQUIRED stored
    // value while this response claimed ISSUED: two different answers
    // for one key, breaking the basic Idempotency-Key guarantee (same
    // key -> same result, always). If session creation succeeds but
    // recording it fails, this falls through to the LOGIN_REQUIRED
    // default below - the real session token was still created in
    // Redis and remains technically valid, but since it's never
    // disclosed anywhere on this path, that's harmless; it simply
    // expires unused. (Actively deleting it is possible but not done
    // here - it costs nothing left sitting unused with its normal TTL.)
    let responseBody: {
      session_token: string | null;
      session_status: 'LOGIN_REQUIRED' | 'ISSUED';
      password_reset_completed: true;
    } = LOGIN_REQUIRED_RESPONSE;
    try {
      await this.sessions.revokeAllForUser(updatedUser.id);
      const token = await this.sessions.create({
        userId: updatedUser.id,
        phone: updatedUser.phone,
        phoneVerifiedAt: updatedUser.phoneVerifiedAt?.toISOString() ?? null,
        sessionVersion: updatedUser.sessionVersion,
      });
      const issued = {
        session_token: token,
        session_status: 'ISSUED' as const,
        password_reset_completed: true as const,
      };

      if (req.idempotencyClaimId) {
        await this.prisma.idempotencyKey.update({
          where: { id: req.idempotencyClaimId },
          data: { responseBody: issued as Prisma.InputJsonValue },
        });
        responseBody = issued;
      }
    } catch (err) {
      this.logger.error(
        `Password reset for user ${updatedUser.id} committed, but issuing (or durably recording) a session failed - returning the recorded LOGIN_REQUIRED answer so a same-key retry stays consistent: ${(err as Error).message}`,
      );
    }

    return responseBody;
  }

  // Sprint 4 (RB-ROLE-002, PDR-008): finalizes a StaffInvite - "same
  // pattern as signup" (verification_token from POST /auth/otp/verify,
  // purpose=staff_invite), but branching on whether the invited phone
  // already has an account, since unlike open self-registration this
  // phone might belong to an existing customer/vendor-owner who is
  // simply adding a branch-employee role to their same account
  // (PDR-008: "one account may be a customer and also hold ... roles").
  @Post('staff-invites/accept')
  @HttpCode(200)
  @UseInterceptors(IdempotencyInterceptor)
  async acceptStaffInvite(
    @Body() dto: StaffInviteAcceptDto,
    @Req() req: Request,
  ) {
    const verification = await this.phoneVerification.consume(
      dto.verification_token,
    );
    if (
      !verification ||
      verification.phone !== dto.phone ||
      verification.purpose !== 'STAFF_INVITE'
    ) {
      throw new BadRequestException({
        code: 'PHONE_NOT_VERIFIED',
        message:
          'This phone number has not been OTP-verified for a staff invite, or the verification has expired',
      });
    }

    // Fast, friendly, non-authoritative fail-fast - see the fresh
    // re-check under the vendor lock inside the transaction below,
    // which is what's actually authoritative (review-round finding:
    // this codebase's own inviteStaff() runs concurrently against
    // this exact endpoint for the same vendor/phone; only re-reading
    // the invite fresh *after* acquiring that same lock can guarantee
    // this is still the row to act on).
    const candidateInvite = await this.prisma.staffInvite.findFirst({
      where: {
        phone: dto.phone,
        status: 'PENDING',
        expiresAt: { gt: new Date() },
      },
      orderBy: { createdAt: 'desc' },
    });
    if (!candidateInvite) {
      throw new NotFoundException({
        code: 'STAFF_INVITE_NOT_FOUND',
        message: 'No pending invite was found for this phone number',
      });
    }

    const existingUserPreCheck = await this.prisma.user.findUnique({
      where: { phone: dto.phone },
    });
    if (!existingUserPreCheck && !dto.password) {
      throw new BadRequestException({
        code: 'PASSWORD_REQUIRED',
        message:
          'A password is required to create an account for this phone number',
      });
    }

    let result;
    try {
      result = await this.prisma.$transaction(async (tx) => {
        // Locks the same phone-keyed advisory lock
        // VendorsController.inviteStaff() locks (not a row lock on
        // this invite's own vendor - see that method's comment for why
        // the key had to widen from a per-vendor row lock to a
        // phone-keyed advisory lock in review round 4, once
        // PDR-008's employee-uniqueness invariant became cross-vendor).
        // Whichever of the two transactions gets here first now fully
        // completes - including the re-checks/writes below - before
        // the other's own lock acquisition can succeed.
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('finalpro:staff_invite:' || ${dto.phone}))`;

        // Re-fetched fresh, under the lock - candidateInvite above is
        // only what picked *which* vendor to lock; it is never used
        // for the actual decision below. A concurrent accept() for
        // this exact same invite (double-accept) or an unrelated
        // change is caught here, not assumed away.
        const invite = await tx.staffInvite.findUnique({
          where: { id: candidateInvite.id },
        });
        if (
          !invite ||
          invite.status !== 'PENDING' ||
          invite.expiresAt.getTime() <= Date.now()
        ) {
          throw new NotFoundException({
            code: 'STAFF_INVITE_NOT_FOUND',
            message: 'No pending invite was found for this phone number',
          });
        }

        // Review-round finding (round 4): re-checked fresh, under the
        // same phone-keyed lock inviteStaff() uses - PDR-008 ties this
        // phone to one BRANCH_EMPLOYEE assignment at a time, across
        // every vendor. Without this, a second, unrelated invite for a
        // different vendor accepted concurrently (both were legitimately
        // PENDING before either commits, e.g. created moments apart
        // before round 4's global pending-invite index existed on
        // older PENDING rows - or simply because this is the
        // authoritative check, not the DB constraint, which only backstops
        // it) would otherwise be free to succeed right up until
        // vendorUser.create() below hit the unique index and failed with
        // a generic, harder-to-label P2002.
        const alreadyEmployeeElsewhere = await tx.vendorUser.findFirst({
          where: { role: 'BRANCH_EMPLOYEE', user: { phone: dto.phone } },
        });
        if (alreadyEmployeeElsewhere) {
          throw new ForbiddenException({
            code: 'EMPLOYEE_ALREADY_ASSIGNED',
            message:
              'This phone number is already assigned as a branch employee elsewhere - reassignment is not supported yet',
          });
        }

        const existingUser = await tx.user.findUnique({
          where: { phone: dto.phone },
        });
        if (!existingUser && !dto.password) {
          throw new BadRequestException({
            code: 'PASSWORD_REQUIRED',
            message:
              'A password is required to create an account for this phone number',
          });
        }

        let userId: string;
        let userPhoneVerifiedAt: Date;
        let userSessionVersion: number;
        if (existingUser) {
          userId = existingUser.id;
          userPhoneVerifiedAt = existingUser.phoneVerifiedAt ?? new Date();
          userSessionVersion = existingUser.sessionVersion;
        } else {
          const passwordHash = await bcrypt.hash(dto.password!, 10);
          const created = await tx.user.create({
            data: {
              phone: dto.phone,
              passwordHash,
              phoneVerifiedAt: new Date(),
            },
          });
          await tx.customerProfile.create({ data: { userId: created.id } });
          userId = created.id;
          userPhoneVerifiedAt = created.phoneVerifiedAt!;
          userSessionVersion = created.sessionVersion;
        }

        const vendorUser = await tx.vendorUser.create({
          data: {
            userId,
            vendorId: invite.vendorId,
            role: 'BRANCH_EMPLOYEE',
            branchId: invite.branchId,
          },
        });
        await tx.staffInvite.update({
          where: { id: invite.id },
          data: { status: 'ACCEPTED', acceptedAt: new Date() },
        });
        await this.auditLog.record(
          {
            actorId: userId,
            correlationId: req.correlationId,
            action: 'vendor_user.staff_invite_accepted',
            entityType: 'VendorUser',
            entityId: vendorUser.id,
            afterState: {
              vendor_id: invite.vendorId,
              branch_id: invite.branchId,
              role: 'BRANCH_EMPLOYEE',
            },
          },
          tx,
        );

        // session_token is necessarily null here - Redis/SessionService
        // never participates in this transaction (same reasoning as
        // confirmPasswordReset()'s LOGIN_REQUIRED default above: session
        // issuance is a pure enhancement on top of an already-committed
        // outcome, never a condition of it). Updated to the real token
        // just below, once issued - a best-effort second write, not
        // something this transaction can wait on.
        const body = {
          vendor_id: invite.vendorId,
          branch_id: invite.branchId,
          role: 'BRANCH_EMPLOYEE' as const,
          session_token: null as string | null,
        };
        await this.idempotencyCompletion.complete(
          tx,
          req.idempotencyClaimId,
          body,
          200,
        );
        return {
          body,
          userId,
          phone: dto.phone,
          phoneVerifiedAt: userPhoneVerifiedAt,
          sessionVersion: userSessionVersion,
        };
      });
    } catch (err) {
      if (
        err instanceof Prisma.PrismaClientKnownRequestError &&
        err.code === 'P2002'
      ) {
        throw new ConflictException({
          code: 'ALREADY_VENDOR_MEMBER',
          message: 'This account is already a member of this vendor',
        });
      }
      throw err;
    }

    const responseWithToken = {
      ...result.body,
      session_token: null as string | null,
    };
    try {
      const token = await this.sessions.create({
        userId: result.userId,
        phone: result.phone,
        phoneVerifiedAt: result.phoneVerifiedAt.toISOString(),
        sessionVersion: result.sessionVersion,
      });
      responseWithToken.session_token = token;

      if (req.idempotencyClaimId) {
        await this.prisma.idempotencyKey.update({
          where: { id: req.idempotencyClaimId },
          data: { responseBody: responseWithToken as Prisma.InputJsonValue },
        });
      }
    } catch (err) {
      // Same resilience as confirmPasswordReset() above: the invite has
      // already durably been accepted and the VendorUser row already
      // durably exists - a session is a pure enhancement on top of
      // that, so a Redis hiccup here must not turn an already-successful
      // request into a 500. The caller gets session_token: null and can
      // log in normally with the password they just set/already had.
      this.logger.error(
        `Staff invite ${candidateInvite.id} accepted for user ${result.userId}, but issuing a session failed: ${(err as Error).message}`,
      );
    }

    return responseWithToken;
  }
}
