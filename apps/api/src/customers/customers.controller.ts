import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  Delete,
  Get,
  HttpCode,
  Logger,
  NotFoundException,
  Param,
  Patch,
  Post,
  Req,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { Request } from 'express';
import { AuditLogService } from '../audit/audit-log.service';
import { CurrentUser } from '../auth/current-user.decorator';
import { loginRequiredResponse } from '../auth/login-required-response.util';
import { PhoneVerificationService } from '../auth/phone-verification.service';
import {
  AuthenticatedUser,
  SessionAuthGuard,
} from '../auth/session-auth.guard';
import { SessionService } from '../auth/session.service';
import {
  lockCustomerAccountState,
  lockCustomerAddressState,
  lockVendorRowsSorted,
} from '../common/customer-account-lock.util';
import { IdempotencyCompletionService } from '../common/idempotency/idempotency-completion.service';
import { IdempotencyInterceptor } from '../common/idempotency/idempotency.interceptor';
import { Prisma } from '../../generated/prisma/client';
import { TERMINAL_BRANCH_ORDER_STATUSES } from '../orders/branch-order-state-machine';
import { PrismaService } from '../prisma/prisma.service';
import { CreateAddressDto } from './dto/create-address.dto';
import { PatchAddressDto } from './dto/patch-address.dto';
import { PatchMeDto } from './dto/patch-me.dto';

const PHONE_CHANGE_IDEMPOTENCY_TTL_MS = 5 * 60 * 1000; // same short window as OTP-verify-adjacent endpoints

@Controller('customers/me')
@UseGuards(SessionAuthGuard)
export class CustomersController {
  private readonly logger = new Logger(CustomersController.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly auditLog: AuditLogService,
    private readonly sessions: SessionService,
    private readonly phoneVerification: PhoneVerificationService,
    private readonly idempotencyCompletion: IdempotencyCompletionService,
  ) {}

  @Get()
  async me(@CurrentUser() user: AuthenticatedUser) {
    // Every account created via POST /auth/register also creates a
    // CustomerProfile in the same transaction, so this can be trusted
    // to exist for any authenticated user.
    const profile = await this.prisma.customerProfile.findUniqueOrThrow({
      where: { userId: user.id },
      include: { user: true },
    });
    return {
      id: profile.user.id,
      phone: profile.user.phone,
      email: profile.user.email,
      language_pref: profile.user.languagePref,
      phone_verified_at: profile.user.phoneVerifiedAt?.toISOString() ?? null,
      display_name: profile.displayName,
    };
  }

  // Sprint 22 (FR-AUTH-006/009): the one generic PATCH SRS Part 4 names
  // literally. Both kinds of change can be requested in the same call.
  //
  // Review-round fix: when `phone` is present, language_pref/display_name
  // are NOT written in their own separate, earlier transaction anymore -
  // that let a request which later failed phone verification (or hit
  // PHONE_ALREADY_REGISTERED) still durably commit the language/name
  // change, a partial success behind an error response. Now every field
  // in the SAME request commits in ONE transaction with the phone
  // change (or none of them do). When `phone` is absent, language_pref/
  // display_name still write immediately in their own transaction -
  // there is no OTP step for them to lose atomicity with.
  @Patch()
  @HttpCode(200)
  @UseInterceptors(IdempotencyInterceptor)
  async patchMe(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: PatchMeDto,
    @Req() req: Request,
  ) {
    if (dto.phone === undefined) {
      if (dto.language_pref !== undefined || dto.display_name !== undefined) {
        await this.prisma.$transaction(async (tx) => {
          if (dto.language_pref !== undefined) {
            await tx.user.update({
              where: { id: user.id },
              data: { languagePref: dto.language_pref },
            });
          }
          if (dto.display_name !== undefined) {
            await tx.customerProfile.update({
              where: { userId: user.id },
              data: { displayName: dto.display_name },
            });
          }
        });
      }

      const profile = await this.prisma.customerProfile.findUniqueOrThrow({
        where: { userId: user.id },
        include: { user: true },
      });
      return {
        id: profile.user.id,
        phone: profile.user.phone,
        language_pref: profile.user.languagePref,
        display_name: profile.displayName,
        session_token: null,
        session_status: null,
      };
    }

    // Phone change: verification_token is guaranteed present by
    // PatchMeDto's own @ValidateIf (phone present => token required).
    // The token proves ownership of the NEW phone (OTP was issued to
    // and verified against dto.phone itself, not the account's
    // current one) - the already-valid session already proves this is
    // the account holder.
    const verification = await this.phoneVerification.consume(
      dto.verification_token!,
    );
    if (
      !verification ||
      verification.phone !== dto.phone ||
      verification.purpose !== 'PHONE_CHANGE'
    ) {
      throw new BadRequestException({
        code: 'PHONE_NOT_VERIFIED',
        message:
          'This phone number has not been OTP-verified for a phone change, or the verification has expired',
      });
    }

    // Review-round requirement: verification_token lives in Redis, not
    // Postgres - consumed above, before this transaction, the same
    // non-atomic-but-accepted sequence register()/reactivateConfirm()
    // already use. If the transaction below fails for any reason -
    // including language_pref/display_name's own writes, now folded in
    // here - NONE of phone/language_pref/display_name changes; the
    // caller sees a clean error with no partial effect, and this
    // consumed token is simply gone (request a fresh OTP and retry).
    let updatedUser: {
      id: string;
      phone: string;
      phoneVerifiedAt: Date | null;
      sessionVersion: number;
    };
    try {
      updatedUser = await this.prisma.$transaction(async (tx) => {
        const updated = await tx.user.update({
          where: { id: user.id },
          data: {
            phone: dto.phone,
            phoneVerifiedAt: new Date(),
            sessionVersion: { increment: 1 },
            ...(dto.language_pref !== undefined
              ? { languagePref: dto.language_pref }
              : {}),
          },
        });
        if (dto.display_name !== undefined) {
          await tx.customerProfile.update({
            where: { userId: user.id },
            data: { displayName: dto.display_name },
          });
        }
        await this.auditLog.record(
          {
            actorId: user.id,
            correlationId: req.correlationId,
            action: 'user.phone_changed',
            entityType: 'User',
            entityId: user.id,
          },
          tx,
        );
        // Durable, always-replayable response from inside this
        // transaction - session issuance below is a pure best-effort
        // enhancement on an already-committed outcome, never a
        // condition of it (same discipline as confirmPasswordReset()/
        // reactivateConfirm()).
        await this.idempotencyCompletion.complete(
          tx,
          req.idempotencyClaimId,
          {
            id: user.id,
            phone: updated.phone,
            ...loginRequiredResponse({ phone_change_completed: true as const }),
          },
          200,
          PHONE_CHANGE_IDEMPOTENCY_TTL_MS,
        );
        return updated;
      });
    } catch (err) {
      if (
        err instanceof Prisma.PrismaClientKnownRequestError &&
        err.code === 'P2002'
      ) {
        throw new ConflictException({
          code: 'PHONE_ALREADY_REGISTERED',
          message: 'An account with this phone number already exists',
        });
      }
      throw err;
    }

    let responseBody: {
      id: string;
      phone: string;
      phone_change_completed: true;
      session_token: string | null;
      session_status: 'LOGIN_REQUIRED' | 'ISSUED';
    } = {
      id: updatedUser.id,
      phone: updatedUser.phone,
      ...loginRequiredResponse({ phone_change_completed: true as const }),
    };
    try {
      const token = await this.sessions.create({
        userId: updatedUser.id,
        phone: updatedUser.phone,
        phoneVerifiedAt: updatedUser.phoneVerifiedAt?.toISOString() ?? null,
        sessionVersion: updatedUser.sessionVersion,
      });
      const issued = {
        id: updatedUser.id,
        phone: updatedUser.phone,
        phone_change_completed: true as const,
        session_token: token,
        session_status: 'ISSUED' as const,
      };
      if (req.idempotencyClaimId) {
        await this.prisma.idempotencyKey.update({
          where: { id: req.idempotencyClaimId },
          data: { responseBody: issued as Prisma.InputJsonValue },
        });
        responseBody = issued;
      }
    } catch (err) {
      // Same resilience as confirmPasswordReset()/reactivateConfirm():
      // the phone change already durably committed - a Redis hiccup
      // here must not turn an already-successful request into an
      // error. The caller logs in normally with the new phone number.
      this.logger.error(
        `Phone changed for user ${updatedUser.id}, but issuing (or durably recording) a session failed - returning the recorded LOGIN_REQUIRED answer so a same-key retry stays consistent: ${(err as Error).message}`,
      );
    }

    return responseBody;
  }

  // Sprint 22 (FR-AUTH-014, PDR-034): "account deletion" per SRS's own
  // literal route name - the actual behavior is FR-AUTH-014's
  // deactivation workflow, never a hard delete.
  @Delete()
  @HttpCode(200)
  @UseInterceptors(IdempotencyInterceptor)
  async deactivate(
    @CurrentUser() user: AuthenticatedUser,
    @Req() req: Request,
  ) {
    await this.prisma.$transaction(async (tx) => {
      // Lock order (customer-account-lock.util.ts's own documented
      // global order): User -> Vendors (sorted) -> active-order check
      // -> write.
      await lockCustomerAccountState(tx, user.id);

      const fresh = await tx.user.findUniqueOrThrow({ where: { id: user.id } });
      if (fresh.deactivatedAt !== null) {
        // Idempotent re-call (e.g. a retried request on the same
        // still-briefly-valid session) - already deactivated, report
        // success without resetting the 30-day recovery clock or
        // bumping sessionVersion again.
        return;
      }

      // Review-round requirement: lock EVERY vendor this user OWNs,
      // sorted, BEFORE deciding anything - a plain per-user lock
      // cannot serialize this decision against a DIFFERENT co-owner's
      // own concurrent deactivation for the SAME vendor (two different
      // users each lock their own, different User row only).
      const ownedVendorIds = (
        await tx.vendorUser.findMany({
          where: { userId: user.id, role: 'OWNER' },
          select: { vendorId: true },
        })
      ).map((v) => v.vendorId);

      if (ownedVendorIds.length > 0) {
        await lockVendorRowsSorted(tx, ownedVendorIds);
        for (const vendorId of ownedVendorIds) {
          const vendor = await tx.vendor.findUniqueOrThrow({
            where: { id: vendorId },
          });
          if (vendor.status === 'CANCELLED') {
            continue; // a closed store has no "active ownership" to protect
          }
          // Re-read fresh, under the vendor lock - the authoritative
          // "who is an active owner right now" answer. ACTIVE + not
          // deactivated, same two conditions the plan names explicitly.
          const activeOwners = await tx.vendorUser.findMany({
            where: {
              vendorId,
              role: 'OWNER',
              status: 'ACTIVE',
              user: { deactivatedAt: null },
            },
            select: { userId: true },
          });
          const otherActiveOwners = activeOwners.filter(
            (o) => o.userId !== user.id,
          );
          if (otherActiveOwners.length === 0) {
            throw new ConflictException({
              code: 'ACTIVE_VENDOR_OWNERSHIP_BLOCKS_DEACTIVATION',
              message:
                'Transfer ownership or close this store before deactivating your account',
            });
          }
        }
      }

      const profile = await tx.customerProfile.findUniqueOrThrow({
        where: { userId: user.id },
      });
      const activeOrder = await tx.branchOrder.findFirst({
        where: {
          customerOrder: { customerId: profile.id },
          status: { notIn: [...TERMINAL_BRANCH_ORDER_STATUSES] },
        },
        select: { id: true },
      });
      if (activeOrder) {
        throw new ConflictException({
          code: 'ACTIVE_ORDER_BLOCKS_DEACTIVATION',
          message:
            'You have an active order - it must be completed or cancelled first',
        });
      }

      await tx.user.update({
        where: { id: user.id },
        data: { deactivatedAt: new Date(), sessionVersion: { increment: 1 } },
      });
      await this.auditLog.record(
        {
          actorId: user.id,
          correlationId: req.correlationId,
          action: 'user.deactivated',
          entityType: 'User',
          entityId: user.id,
        },
        tx,
      );
    });
    return { deactivated: true };
  }

  // BL-AUTH-004/004b (FR-AUTH-008, PDR-029): create an address.
  // Pre-existing endpoint since Sprint 2 - no Idempotency-Key
  // requirement here (unlike the new Sprint 22 mutating routes below):
  // adding one would be a breaking contract change for every existing
  // caller (older e2e suites, the frontend AddressForm) that never
  // sent that header, and nothing in the approved S22 plan asked for
  // key-based idempotency on plain address creation.
  @Post('addresses')
  async createAddress(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: CreateAddressDto,
    @Req() req: Request,
  ) {
    const profile = await this.prisma.customerProfile.findUniqueOrThrow({
      where: { userId: user.id },
    });

    const address = await this.prisma.$transaction(async (tx) => {
      // Every address-mutating operation for this customer takes this
      // lock first - not just set-default - so two concurrent create()
      // calls for a customer with zero addresses can never both decide
      // "I am the first, I become default."
      await lockCustomerAddressState(tx, profile.id);
      const existingActiveCount = await tx.address.count({
        where: { customerId: profile.id, archivedAt: null },
      });
      const created = await tx.address.create({
        data: {
          customerId: profile.id,
          label: dto.label,
          lat: dto.lat,
          lng: dto.lng,
          landmarkNote: dto.landmark_note,
          phoneNumber1: dto.phone_number_1,
          phoneNumber2: dto.phone_number_2,
          zone: dto.zone,
          // The first address a customer ever saves becomes default
          // automatically - a later one does not.
          isDefault: existingActiveCount === 0,
        },
      });
      await this.auditLog.record(
        {
          actorId: user.id,
          correlationId: req.correlationId,
          action: 'address.created',
          entityType: 'Address',
          entityId: created.id,
          afterState: {
            lat: created.lat,
            lng: created.lng,
            label: created.label,
            is_default: created.isDefault,
          },
        },
        tx,
      );
      return created;
    });

    return addressDto(address);
  }

  // Sprint 10 (RB-ORD-002): checkout needs the customer to pick a
  // saved address. Archived addresses never appear here - Sprint 22.
  @Get('addresses')
  async listAddresses(@CurrentUser() user: AuthenticatedUser) {
    const profile = await this.prisma.customerProfile.findUniqueOrThrow({
      where: { userId: user.id },
    });
    const addresses = await this.prisma.address.findMany({
      where: { customerId: profile.id, archivedAt: null },
      orderBy: { createdAt: 'desc' },
    });
    return addresses.map(addressDto);
  }

  // Sprint 22 (FR-AUTH-008, PDR-029): partial update, including
  // is_default (folded into this same generic PATCH, not a bespoke
  // /set-default route).
  @Patch('addresses/:id')
  @UseInterceptors(IdempotencyInterceptor)
  async patchAddress(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Body() dto: PatchAddressDto,
    @Req() req: Request,
  ) {
    const profile = await this.prisma.customerProfile.findUniqueOrThrow({
      where: { userId: user.id },
    });

    const updated = await this.prisma.$transaction(async (tx) => {
      await lockCustomerAddressState(tx, profile.id);
      const existing = await tx.address.findUnique({ where: { id } });
      if (
        !existing ||
        existing.customerId !== profile.id ||
        existing.archivedAt !== null
      ) {
        // BOLA: never confirm or deny that an address belonging to
        // someone else (or already archived) exists.
        throw new NotFoundException({
          code: 'ADDRESS_NOT_FOUND',
          message: 'Address not found',
        });
      }

      const fieldData: Prisma.AddressUpdateInput = {
        ...(dto.label !== undefined ? { label: dto.label } : {}),
        ...(dto.lat !== undefined ? { lat: dto.lat } : {}),
        ...(dto.lng !== undefined ? { lng: dto.lng } : {}),
        ...(dto.landmark_note !== undefined
          ? { landmarkNote: dto.landmark_note }
          : {}),
        ...(dto.phone_number_1 !== undefined
          ? { phoneNumber1: dto.phone_number_1 }
          : {}),
        ...(dto.phone_number_2 !== undefined
          ? { phoneNumber2: dto.phone_number_2 }
          : {}),
        ...(dto.zone !== undefined ? { zone: dto.zone } : {}),
      };
      if (Object.keys(fieldData).length > 0) {
        await tx.address.update({ where: { id }, data: fieldData });
      }
      if (dto.is_default === true) {
        // Clear the previous default FIRST, then set this one -
        // review-round requirement, same sequencing as the archive
        // path below.
        await tx.address.updateMany({
          where: { customerId: profile.id, isDefault: true },
          data: { isDefault: false },
        });
        await tx.address.update({
          where: { id },
          data: { isDefault: true },
        });
      }
      const result = await tx.address.findUniqueOrThrow({ where: { id } });
      await this.auditLog.record(
        {
          actorId: user.id,
          correlationId: req.correlationId,
          action: 'address.updated',
          entityType: 'Address',
          entityId: id,
          afterState: { is_default: result.isDefault },
        },
        tx,
      );
      return result;
    });

    return addressDto(updated);
  }

  // Sprint 22 (FR-AUTH-008, PDR-029): "delete" per SRS's own literal
  // route name - a never-referenced address is hard-deleted; a
  // referenced one (even by a long-terminal historical order -
  // BranchOrder.address has onDelete:Restrict, by design, forever)
  // is soft-archived instead, so that order's own address stays
  // readable while disappearing from this customer's own list/picker.
  @Delete('addresses/:id')
  @HttpCode(200)
  @UseInterceptors(IdempotencyInterceptor)
  async deleteAddress(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Req() req: Request,
  ) {
    const profile = await this.prisma.customerProfile.findUniqueOrThrow({
      where: { userId: user.id },
    });

    await this.prisma.$transaction(async (tx) => {
      await lockCustomerAddressState(tx, profile.id);
      const existing = await tx.address.findUnique({ where: { id } });
      if (
        !existing ||
        existing.customerId !== profile.id ||
        existing.archivedAt !== null
      ) {
        throw new NotFoundException({
          code: 'ADDRESS_NOT_FOUND',
          message: 'Address not found',
        });
      }

      const activeOrder = await tx.branchOrder.findFirst({
        where: {
          addressId: id,
          status: { notIn: [...TERMINAL_BRANCH_ORDER_STATUSES] },
        },
        select: { id: true },
      });
      if (activeOrder) {
        throw new ConflictException({
          code: 'ADDRESS_IN_USE_BY_ACTIVE_ORDER',
          message:
            "This address is used by an active order - change that order's address first, or wait for it to finish",
        });
      }

      const everUsed = await tx.branchOrder.findFirst({
        where: { addressId: id },
        select: { id: true },
      });
      if (everUsed) {
        // Clear isDefault in the SAME update that archives it -
        // review-round requirement: never leave an archived row
        // carrying isDefault=true, even momentarily.
        await tx.address.update({
          where: { id },
          data: { archivedAt: new Date(), isDefault: false },
        });
      } else {
        await tx.address.delete({ where: { id } });
      }

      if (existing.isDefault) {
        const nextDefault = await tx.address.findFirst({
          where: { customerId: profile.id, archivedAt: null, id: { not: id } },
          orderBy: { createdAt: 'asc' },
        });
        if (nextDefault) {
          await tx.address.update({
            where: { id: nextDefault.id },
            data: { isDefault: true },
          });
        }
        // No remaining active address: no default at all, by design.
      }

      await this.auditLog.record(
        {
          actorId: user.id,
          correlationId: req.correlationId,
          action: everUsed ? 'address.archived' : 'address.deleted',
          entityType: 'Address',
          entityId: id,
        },
        tx,
      );
    });

    return { id, deleted: true };
  }
}

function addressDto(address: {
  id: string;
  label: string | null;
  lat: number;
  lng: number;
  landmarkNote: string | null;
  phoneNumber1: string;
  phoneNumber2: string | null;
  zone: string | null;
  isDefault: boolean;
}) {
  return {
    id: address.id,
    label: address.label,
    lat: address.lat,
    lng: address.lng,
    landmark_note: address.landmarkNote,
    phone_number_1: address.phoneNumber1,
    phone_number_2: address.phoneNumber2,
    zone: address.zone,
    is_default: address.isDefault,
  };
}
