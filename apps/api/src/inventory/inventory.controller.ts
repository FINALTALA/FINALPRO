import {
  Body,
  ConflictException,
  Controller,
  Get,
  HttpCode,
  NotFoundException,
  Param,
  Post,
  Req,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { randomUUID } from 'crypto';
import { Request } from 'express';
import { AuditLogService } from '../audit/audit-log.service';
import { CurrentUser } from '../auth/current-user.decorator';
import {
  AuthenticatedUser,
  SessionAuthGuard,
} from '../auth/session-auth.guard';
import { VendorMembershipGuard } from '../auth/vendor-membership.guard';
import { IdempotencyCompletionService } from '../common/idempotency/idempotency-completion.service';
import { IdempotencyInterceptor } from '../common/idempotency/idempotency.interceptor';
import { OutboxEventService } from '../outbox/outbox-event.service';
import { PrismaService } from '../prisma/prisma.service';
import { CreateStockMovementDto } from './dto/create-stock-movement.dto';

function stockDto(row: {
  id: string | null;
  vendorId: string;
  branchId: string;
  offerVariantId: string;
  quantity: number;
}) {
  return {
    id: row.id,
    vendor_id: row.vendorId,
    branch_id: row.branchId,
    offer_variant_id: row.offerVariantId,
    quantity: row.quantity,
  };
}

function movementDto(m: {
  id: string;
  vendorId: string;
  branchId: string;
  offerVariantId: string;
  quantityDelta: number;
  resultingQuantity: number;
  reason: string;
  reasonNote: string;
  actorId: string;
  createdAt: Date;
}) {
  return {
    id: m.id,
    vendor_id: m.vendorId,
    branch_id: m.branchId,
    offer_variant_id: m.offerVariantId,
    quantity_delta: m.quantityDelta,
    resulting_quantity: m.resultingQuantity,
    reason: m.reason,
    reason_note: m.reasonNote,
    actor_id: m.actorId,
    created_at: m.createdAt.toISOString(),
  };
}

// Sprint 6 (RB-INV-002/003/005, PDR-020/021): branch-level stock and
// its movement log. Every route here has both :vendorId and :branchId,
// so VendorMembershipGuard's own branch-scoping already gives exactly
// PDR-009's "an employee controls only the assigned branch's...
// stock" - a BRANCH_EMPLOYEE whose own branchId doesn't match the
// route is refused (BRANCH_ACCESS_DENIED) before this controller ever
// runs; an OWNER is never subject to that check. No @RequireVendorRole
// needed - both roles may act here, just scoped differently, which the
// guard alone already enforces. No cross-branch transfer exists
// anywhere in this controller, deliberately (RB-INV-002's own scope
// line, PDR-020).
@Controller('vendors')
@UseGuards(SessionAuthGuard, VendorMembershipGuard)
export class InventoryController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auditLog: AuditLogService,
    private readonly idempotencyCompletion: IdempotencyCompletionService,
    private readonly outbox: OutboxEventService,
  ) {}

  private async requireBranch(vendorId: string, branchId: string) {
    const branch = await this.prisma.storeBranch.findUnique({
      where: { id: branchId },
    });
    if (!branch || branch.vendorId !== vendorId) {
      throw new NotFoundException({
        code: 'BRANCH_NOT_FOUND',
        message: 'Branch not found for this vendor',
      });
    }
  }

  private async requireOfferVariant(vendorId: string, offerVariantId: string) {
    const variant = await this.prisma.offerVariant.findUnique({
      where: { id: offerVariantId },
    });
    if (!variant || variant.vendorId !== vendorId) {
      throw new NotFoundException({
        code: 'OFFER_VARIANT_NOT_FOUND',
        message: 'Offer variant not found for this vendor',
      });
    }
  }

  @Get(':vendorId/branches/:branchId/stock')
  async listStock(
    @Param('vendorId') vendorId: string,
    @Param('branchId') branchId: string,
  ) {
    await this.requireBranch(vendorId, branchId);
    const rows = await this.prisma.branchStock.findMany({
      where: { vendorId, branchId },
      orderBy: { createdAt: 'asc' },
    });
    return rows.map(stockDto);
  }

  @Get(':vendorId/branches/:branchId/stock/:offerVariantId')
  async getStock(
    @Param('vendorId') vendorId: string,
    @Param('branchId') branchId: string,
    @Param('offerVariantId') offerVariantId: string,
  ) {
    await this.requireBranch(vendorId, branchId);
    await this.requireOfferVariant(vendorId, offerVariantId);
    const row = await this.prisma.branchStock.findUnique({
      where: { branchId_offerVariantId: { branchId, offerVariantId } },
    });
    // No row yet simply means this branch has never had a movement
    // against this variant - reported as zero, not 404, since zero
    // stock is a perfectly normal, real state (see this controller's
    // own note on there being no separate "initialize stock" endpoint).
    if (!row) {
      return stockDto({
        id: null,
        vendorId,
        branchId,
        offerVariantId,
        quantity: 0,
      });
    }
    return stockDto(row);
  }

  @Get(':vendorId/branches/:branchId/stock/:offerVariantId/movements')
  async listMovements(
    @Param('vendorId') vendorId: string,
    @Param('branchId') branchId: string,
    @Param('offerVariantId') offerVariantId: string,
  ) {
    await this.requireBranch(vendorId, branchId);
    await this.requireOfferVariant(vendorId, offerVariantId);
    const movements = await this.prisma.stockMovement.findMany({
      where: { vendorId, branchId, offerVariantId },
      orderBy: { createdAt: 'desc' },
    });
    return movements.map(movementDto);
  }

  // RB-INV-003/005: the *only* endpoint in this codebase that ever
  // changes BranchStock.quantity - see that model's own schema comment
  // for why there is no separate direct-set endpoint. The atomic
  // conditional write below (an INSERT ... ON CONFLICT DO NOTHING to
  // guarantee a row exists at 0, then a single UPDATE ... WHERE
  // quantity + delta >= 0 ... RETURNING) is what makes the decrement
  // safe under concurrency: two concurrent requests against the same
  // (branchId, offerVariantId) serialize naturally at the row-lock
  // Postgres already takes for an UPDATE - there is no separate
  // read-then-write race window to close with an advisory lock, unlike
  // this codebase's other concurrency-sensitive endpoints (e.g. staff
  // invites), because the check and the write are the exact same
  // statement.
  @Post(':vendorId/branches/:branchId/stock/:offerVariantId/movements')
  @HttpCode(201)
  @UseInterceptors(IdempotencyInterceptor)
  async createMovement(
    @Param('vendorId') vendorId: string,
    @Param('branchId') branchId: string,
    @Param('offerVariantId') offerVariantId: string,
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: CreateStockMovementDto,
    @Req() req: Request,
  ) {
    await this.requireBranch(vendorId, branchId);
    await this.requireOfferVariant(vendorId, offerVariantId);

    // DAMAGE/LOSS can only ever reduce stock - PDR-021 lists them
    // alongside "count correction" as the three non-sale reasons, but
    // only a count correction can legitimately go either direction (a
    // physical recount can find more stock than recorded).
    if (
      (dto.reason === 'DAMAGE' || dto.reason === 'LOSS') &&
      dto.quantity_delta > 0
    ) {
      throw new ConflictException({
        code: 'INVALID_MOVEMENT_DIRECTION',
        message: 'DAMAGE/LOSS movements must have a negative quantity_delta',
      });
    }

    const body = await this.prisma.$transaction(async (tx) => {
      const newStockId = randomUUID();
      await tx.$executeRaw`
        INSERT INTO branch_stock (id, "vendorId", "branchId", "offerVariantId", quantity, "createdAt", "updatedAt")
        VALUES (${newStockId}, ${vendorId}, ${branchId}, ${offerVariantId}, 0, now(), now())
        ON CONFLICT ("branchId", "offerVariantId") DO NOTHING
      `;
      // Sprint 10 (RB-ORD-002): the "- reservedQuantity" guard is the
      // reason a customer's 10-minute checkout hold is a REAL
      // guarantee - without it, this physical/manual movement (the
      // only other writer of branch_stock.quantity in this codebase)
      // could sell stock a live online reservation is already holding,
      // and that checkout's own confirm step would only discover the
      // shortfall later. The guard is a no-op for every INCREASE
      // (quantity_delta > 0): quantity already >= reservedQuantity by
      // this table's own CHECK invariant, so adding a positive delta
      // can never make the condition false - restocking is never
      // blocked. See BranchStock.reservedQuantity's own schema.prisma
      // comment for the full design.
      const updated = await tx.$queryRaw<{ id: string; quantity: number }[]>`
        UPDATE branch_stock
        SET quantity = quantity + ${dto.quantity_delta}, "updatedAt" = now()
        WHERE "branchId" = ${branchId}
          AND "offerVariantId" = ${offerVariantId}
          AND quantity + ${dto.quantity_delta} - "reservedQuantity" >= 0
        RETURNING id, quantity
      `;
      if (updated.length === 0) {
        throw new ConflictException({
          code: 'INSUFFICIENT_STOCK',
          message:
            'This movement would take branch stock below zero - not applied',
        });
      }
      const resultingQuantity = updated[0].quantity;

      const movement = await tx.stockMovement.create({
        data: {
          vendorId,
          branchId,
          offerVariantId,
          quantityDelta: dto.quantity_delta,
          resultingQuantity,
          reason: dto.reason,
          reasonNote: dto.reason_note,
          actorId: user.id,
        },
      });

      await this.auditLog.record(
        {
          actorId: user.id,
          correlationId: req.correlationId,
          action: 'stock_movement.recorded',
          entityType: 'StockMovement',
          entityId: movement.id,
          afterState: movementDto(movement),
        },
        tx,
      );

      // RB-INV-003, PDR-021: "immediately notify the owner...
      // regardless of amount." Written in the same transaction as the
      // movement itself, the same durable-outbox pattern this codebase
      // already established (ADR-006, see OutboxEventService's own
      // comment) for every not-yet-integrated notification channel -
      // the relay worker that actually delivers this is separate
      // infrastructure, not built this sprint (no email/push provider
      // is selected yet, the same deferred-channel pattern as
      // OPEN-004's SMS fallback). What matters for RB-INV-003 is that
      // the intent to notify is durably, atomically recorded - never
      // silently dropped if this request succeeds.
      await this.outbox.enqueue(
        {
          eventType: 'stock_movement.owner_notification',
          payload: {
            vendor_id: vendorId,
            branch_id: branchId,
            offer_variant_id: offerVariantId,
            stock_movement_id: movement.id,
            quantity_delta: dto.quantity_delta,
            resulting_quantity: resultingQuantity,
            reason: dto.reason,
            reason_note: dto.reason_note,
            actor_id: user.id,
          },
        },
        tx,
      );

      const responseBody = movementDto(movement);
      await this.idempotencyCompletion.complete(
        tx,
        req.idempotencyClaimId,
        responseBody,
        201,
      );
      return responseBody;
    });

    return body;
  }
}
