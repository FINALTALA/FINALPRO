import {
  Body,
  Controller,
  HttpCode,
  Post,
  Req,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { Request } from 'express';
import { AuditLogService } from '../audit/audit-log.service';
import { CurrentUser } from '../auth/current-user.decorator';
import {
  AuthenticatedUser,
  SessionAuthGuard,
} from '../auth/session-auth.guard';
import { IdempotencyCompletionService } from '../common/idempotency/idempotency-completion.service';
import { IdempotencyInterceptor } from '../common/idempotency/idempotency.interceptor';
import { PrismaService } from '../prisma/prisma.service';
import { CreateVendorDto } from './dto/create-vendor.dto';

// FR-VEND-001 / BL-VEND-001: any authenticated user can submit a
// vendor application - there's no separate "vendor applicant" role.
// Idempotency-Key is required here (not explicitly called out for this
// route in Part 4, H.3's fully-specified list, but well within H.1's
// general rule for a mutating endpoint that creates a real business
// resource): a flaky network retry on this form must not silently
// create two vendor applications. Being authenticated + idempotent
// together also makes this the natural home for the scope-isolation
// coverage EPIC-FOUND's Sprint 1 review deferred to Sprint 2 - see
// vendors.e2e-spec.ts.
@Controller('vendors')
@UseGuards(SessionAuthGuard)
export class VendorsController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auditLog: AuditLogService,
    private readonly idempotencyCompletion: IdempotencyCompletionService,
  ) {}

  @Post()
  @HttpCode(201)
  @UseInterceptors(IdempotencyInterceptor)
  async apply(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: CreateVendorDto,
    @Req() req: Request,
  ) {
    return this.prisma.$transaction(async (tx) => {
      const created = await tx.vendor.create({
        data: { legalName: dto.legal_name },
      });
      await tx.vendorUser.create({
        data: { userId: user.id, vendorId: created.id, role: 'OWNER' },
      });
      // Sprint 3 review round 4: createMany() only returns a row count,
      // not the created rows - the response body (which must include
      // each branch's id) can't be built from it without a *separate*,
      // post-transaction findMany(), which is exactly what left this
      // endpoint unable to call IdempotencyCompletionService.complete()
      // from inside the transaction. Individual create() calls give
      // back each row, so the full response can be assembled - and the
      // completion recorded - before the transaction ever commits.
      const branches = await Promise.all(
        dto.branches.map((branch) =>
          tx.storeBranch.create({
            data: {
              vendorId: created.id,
              name: branch.name,
              isPhysical: branch.is_physical,
              lat: branch.lat,
              lng: branch.lng,
            },
          }),
        ),
      );
      await this.auditLog.record(
        {
          actorId: user.id,
          correlationId: req.correlationId,
          action: 'vendor.applied',
          entityType: 'Vendor',
          entityId: created.id,
          afterState: { legalName: created.legalName, status: created.status },
        },
        tx,
      );

      const body = {
        id: created.id,
        legal_name: created.legalName,
        status: created.status,
        branches: branches.map((b) => ({
          id: b.id,
          name: b.name,
          is_physical: b.isPhysical,
          lat: b.lat,
          lng: b.lng,
        })),
      };
      await this.idempotencyCompletion.complete(
        tx,
        req.idempotencyClaimId,
        body,
        201,
      );
      return body;
    });
  }
}
