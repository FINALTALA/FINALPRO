import { BlockWhenSuspended } from '../auth/vendor-suspended.guard';
import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  Get,
  HttpCode,
  NotFoundException,
  Param,
  Post,
  Put,
  Query,
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
import { RequireVendorRole } from '../auth/vendor-role.decorator';
import { IdempotencyCompletionService } from '../common/idempotency/idempotency-completion.service';
import { IdempotencyInterceptor } from '../common/idempotency/idempotency.interceptor';
import { lockAndSweepStockRow } from '../checkout/stock-lock.util';
import {
  decodeCursor,
  encodeCursor,
  isIsoDateString,
  isUuidLike,
  parseLimit,
} from '../platform-admin/cursor.util';
import { Prisma } from '../../generated/prisma/client';
import { OutboxEventService } from '../outbox/outbox-event.service';
import { PrismaService } from '../prisma/prisma.service';
import { ConfirmPhysicalCountDto } from './dto/confirm-physical-count.dto';
import { CreateStockMovementDto } from './dto/create-stock-movement.dto';
import { SetSafetyStockThresholdDto } from './dto/set-safety-stock-threshold.dto';

const STALE_AFTER_MS = 7 * 24 * 60 * 60 * 1000; // Sprint 18a (NFR-STALE-001): 7 days, manual-count only - no API/feed freshness source exists yet.

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

interface BranchStockRow {
  id: string;
  vendorId: string;
  branchId: string;
  offerVariantId: string;
  quantity: number;
  reservedQuantity: number;
  safetyStockThreshold: number;
  lastPhysicalCountAt: Date | null;
  createdAt: Date;
}

interface VariantDisplayInfo {
  sellerSku: string;
  colour: string | null;
  size: string | null;
  storeInventoryBarcode: string;
  vendorOffer: { titleAr: string; titleEn: string };
}

// Sprint 18a: the one rich shape used by every endpoint that an actual
// inventory UI reads from (stock/page, stock/lookup, and the
// single-variant GET) - offer/variant display data a bare BranchStock
// row can't supply, plus the two computed flags (is_low_stock,
// is_stale) a card/row needs to render directly, no second request.
// GET .../stock (the list) deliberately keeps the old, bare stockDto()
// above - unchanged, so nothing that already depends on its shape
// breaks; this richer shape is additive via new routes instead (the
// review-round fix that replaced an earlier plan to change .../stock
// itself).
function enrichedStockDto(
  stock: {
    id: string | null;
    vendorId: string;
    branchId: string;
    offerVariantId: string;
    quantity: number;
    reservedQuantity: number;
    safetyStockThreshold: number;
    lastPhysicalCountAt: Date | null;
  },
  variant: VariantDisplayInfo,
) {
  const available = stock.quantity - stock.reservedQuantity;
  // threshold > 0 is load-bearing - 0 means "alerting disabled", never
  // "alert the moment available reaches zero" (a bare `<=` would do
  // exactly that, since every never-touched row starts at 0/0).
  const isLowStock =
    stock.safetyStockThreshold > 0 && available <= stock.safetyStockThreshold;
  const isStale =
    stock.lastPhysicalCountAt === null ||
    stock.lastPhysicalCountAt.getTime() < Date.now() - STALE_AFTER_MS;
  return {
    id: stock.id,
    vendor_id: stock.vendorId,
    branch_id: stock.branchId,
    offer_variant_id: stock.offerVariantId,
    offer_title_ar: variant.vendorOffer.titleAr,
    offer_title_en: variant.vendorOffer.titleEn,
    seller_sku: variant.sellerSku,
    colour: variant.colour,
    size: variant.size,
    store_inventory_barcode: variant.storeInventoryBarcode,
    quantity: stock.quantity,
    reserved_quantity: stock.reservedQuantity,
    available_quantity: available,
    safety_stock_threshold: stock.safetyStockThreshold,
    last_physical_count_at: stock.lastPhysicalCountAt?.toISOString() ?? null,
    is_low_stock: isLowStock,
    is_stale: isStale,
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
// needed on the OWNER/EMPLOYEE-shared routes - the guard alone already
// enforces the right scope; safety-stock is the one OWNER-only
// exception (a policy decision, not a day-to-day operational action).
// No cross-branch transfer exists anywhere in this controller,
// deliberately (RB-INV-002's own scope line, PDR-020).
//
// Sprint 18a adds: SALE as a plain movement reason (never a checkout/
// payment flow), a per-(branch, variant) safety-stock threshold, an
// explicit physical-count timestamp independent of quantity/updatedAt,
// a vendor-and-branch-scoped barcode lookup, and deterministic
// pagination for the stock list (as a new, additive route - the old
// bare-array GET .../stock is untouched).
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

  // Returns the variant (with its display info already joined) so
  // every caller that needs offer_title/sku/colour/size/barcode for
  // the enriched DTO can reuse this one lookup instead of a second
  // query - callers that don't need the display fields (movements,
  // confirm-count's own identity check) simply don't use the return
  // value.
  private async requireOfferVariant(vendorId: string, offerVariantId: string) {
    const variant = await this.prisma.offerVariant.findUnique({
      where: { id: offerVariantId },
      include: { vendorOffer: true },
    });
    if (!variant || variant.vendorId !== vendorId) {
      throw new NotFoundException({
        code: 'OFFER_VARIANT_NOT_FOUND',
        message: 'Offer variant not found for this vendor',
      });
    }
    return variant;
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

  // Sprint 18a: the paginated, display-ready sibling of the bare
  // GET .../stock above - the actual inventory page reads from this
  // one. A NEW route rather than changing .../stock's own response
  // shape (review-round fix - a breaking array-to-object change was
  // rejected). Declared before the :offerVariantId route below so
  // Nest/Express's declaration-order route matching doesn't swallow
  // the literal "page" segment as a variant id.
  @Get(':vendorId/branches/:branchId/stock/page')
  async listStockPage(
    @Param('vendorId') vendorId: string,
    @Param('branchId') branchId: string,
    @Query('cursor') cursorRaw?: string,
    @Query('limit') limitRaw?: string,
  ) {
    await this.requireBranch(vendorId, branchId);
    const limit = parseLimit(limitRaw);
    const cursor = decodeCursor(cursorRaw, [isIsoDateString, isUuidLike]);

    const where: Prisma.BranchStockWhereInput = { vendorId, branchId };
    if (cursor) {
      const [cursorCreatedAtRaw, cursorId] = cursor as [string, string];
      const cursorCreatedAt = new Date(cursorCreatedAtRaw);
      where.OR = [
        { createdAt: { gt: cursorCreatedAt } },
        { createdAt: cursorCreatedAt, id: { gt: cursorId } },
      ];
    }

    const rows = await this.prisma.branchStock.findMany({
      where,
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      take: limit + 1,
      include: { offerVariant: { include: { vendorOffer: true } } },
    });

    const page = rows.slice(0, limit);
    const last = page[page.length - 1];
    return {
      items: page.map((r) => enrichedStockDto(r, r.offerVariant)),
      next_cursor:
        rows.length > limit && last
          ? encodeCursor([last.createdAt.toISOString(), last.id])
          : null,
    };
  }

  // Sprint 18a: resolves a scanned/typed storeInventoryBarcode to its
  // stock row at THIS branch. Scoped to (vendorId, storeInventoryBarcode)
  // first - that column is @@unique([vendorId, storeInventoryBarcode]),
  // never globally unique, so a barcode belonging to a DIFFERENT vendor
  // is structurally invisible to this query, not a case to special-case.
  // Then requires an ACTUAL BranchStock row at THIS branchId - a
  // product this vendor sells but has never stocked at this specific
  // branch must not silently "open" a row that doesn't exist here
  // (review-round fix). Both failure cases - barcode unknown to this
  // vendor at all, or known but not stocked at this branch - return the
  // exact same 404 code, deliberately: distinguishing them would leak
  // "this barcode exists at one of your other branches" to a request
  // scoped to a branch that doesn't have it.
  @Get(':vendorId/branches/:branchId/stock/lookup')
  async lookupByBarcode(
    @Param('vendorId') vendorId: string,
    @Param('branchId') branchId: string,
    @Query('barcode') barcodeRaw?: string,
  ) {
    await this.requireBranch(vendorId, branchId);
    const barcode = barcodeRaw?.trim();
    if (!barcode) {
      throw new BadRequestException({
        code: 'BARCODE_REQUIRED',
        message: 'barcode query parameter is required',
      });
    }

    const notFoundAtBranch = () =>
      new NotFoundException({
        code: 'BARCODE_NOT_FOUND_AT_BRANCH',
        message: 'No stock record for this barcode at this branch',
      });

    const variant = await this.prisma.offerVariant.findFirst({
      where: { vendorId, storeInventoryBarcode: barcode },
      include: { vendorOffer: true },
    });
    if (!variant) {
      throw notFoundAtBranch();
    }

    const row = await this.prisma.branchStock.findUnique({
      where: {
        branchId_offerVariantId: { branchId, offerVariantId: variant.id },
      },
    });
    if (!row) {
      throw notFoundAtBranch();
    }

    return enrichedStockDto(row, variant);
  }

  @Get(':vendorId/branches/:branchId/stock/:offerVariantId')
  async getStock(
    @Param('vendorId') vendorId: string,
    @Param('branchId') branchId: string,
    @Param('offerVariantId') offerVariantId: string,
  ) {
    await this.requireBranch(vendorId, branchId);
    const variant = await this.requireOfferVariant(vendorId, offerVariantId);
    const row = await this.prisma.branchStock.findUnique({
      where: { branchId_offerVariantId: { branchId, offerVariantId } },
    });
    // No row yet simply means this branch has never had a movement
    // against this variant - reported as zero, not 404, since zero
    // stock is a perfectly normal, real state (see this controller's
    // own note on there being no separate "initialize stock" endpoint).
    if (!row) {
      return enrichedStockDto(
        {
          id: null,
          vendorId,
          branchId,
          offerVariantId,
          quantity: 0,
          reservedQuantity: 0,
          safetyStockThreshold: 0,
          lastPhysicalCountAt: null,
        },
        variant,
      );
    }
    return enrichedStockDto(row, variant);
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
  //
  // Sprint 18a: SALE joins DAMAGE/LOSS as a reason that can only ever
  // reduce stock (a sale can't un-sell something by going positive).
  // SALE does NOT update lastPhysicalCountAt - selling an item is a
  // real stock change, not a human having walked the shelf and counted
  // it - and does NOT enqueue the PDR-021 owner-notification Outbox
  // event DAMAGE/LOSS/COUNT_CORRECTION get: a routine, repeated sale
  // (potentially dozens a day) is not what PDR-021 means by "notify
  // the owner immediately" - only the owner notification differs;
  // StockMovement + AuditLog are recorded for every reason alike.
  @BlockWhenSuspended()
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

    // DAMAGE/LOSS/SALE can only ever reduce stock - PDR-021 lists
    // DAMAGE/LOSS/COUNT_CORRECTION as the non-sale reasons, and SALE
    // (Sprint 18a) joins the "reduction only" side of that same rule;
    // only a count correction can legitimately go either direction (a
    // physical recount can find more stock than recorded).
    if (
      (dto.reason === 'DAMAGE' ||
        dto.reason === 'LOSS' ||
        dto.reason === 'SALE') &&
      dto.quantity_delta > 0
    ) {
      throw new ConflictException({
        code: 'INVALID_MOVEMENT_DIRECTION',
        message:
          'DAMAGE/LOSS/SALE movements must have a negative quantity_delta',
      });
    }

    const body = await this.prisma.$transaction(async (tx) => {
      const newStockId = randomUUID();
      await tx.$executeRaw`
        INSERT INTO branch_stock (id, "vendorId", "branchId", "offerVariantId", quantity, "createdAt", "updatedAt")
        VALUES (${newStockId}, ${vendorId}, ${branchId}, ${offerVariantId}, 0, now(), now())
        ON CONFLICT ("branchId", "offerVariantId") DO NOTHING
      `;
      // Codex review round 2 on commit d0ea80d: the "- reservedQuantity"
      // guard below is only correct against a FRESH reservedQuantity -
      // a hold that expired 10 minutes ago but was never swept (because
      // nobody has since tried to RE-reserve against this exact row)
      // would otherwise sit there blocking a legitimate physical sale
      // indefinitely, which is not what "lazy expiry" is supposed to
      // mean. lockAndSweepStockRow() locks this row and releases any
      // expired holds on it - the same shared primitive reserve() uses
      // - before the conditional UPDATE below even runs, so this sale
      // is judged against the TRUE current hold, not a stale one.
      await lockAndSweepStockRow(tx, vendorId, branchId, offerVariantId);
      // The guard is a no-op for every INCREASE (quantity_delta > 0):
      // quantity already >= reservedQuantity by this table's own CHECK
      // invariant, so adding a positive delta can never make the
      // condition false - restocking is never blocked. See
      // BranchStock.reservedQuantity's own schema.prisma comment for
      // the full design. Note: lastPhysicalCountAt is deliberately NOT
      // touched by this UPDATE - see this method's own comment above.
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
      // regardless of amount" - for DAMAGE/LOSS/COUNT_CORRECTION only.
      // SALE is excluded (Sprint 18a, see this method's own top
      // comment) - a routine sale enqueuing the same event could
      // happen dozens of times a day, which is not what PDR-021's
      // "immediately notify" is for. Written in the same transaction
      // as the movement itself, the same durable-outbox pattern this
      // codebase already established (ADR-006, see OutboxEventService's
      // own comment) for every not-yet-integrated notification channel.
      if (dto.reason !== 'SALE') {
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
      }

      // Sprint 18a: a COUNT_CORRECTION is, by PDR-021's own definition,
      // the result of an actual physical recount - the one movement
      // reason that counts as a real human-at-the-shelf confirmation,
      // same as the dedicated confirm-count endpoint below.
      if (dto.reason === 'COUNT_CORRECTION') {
        await tx.branchStock.update({
          where: { branchId_offerVariantId: { branchId, offerVariantId } },
          data: { lastPhysicalCountAt: new Date() },
        });
      }

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

  // Sprint 18a (review-round fix): a dedicated, explicit "I physically
  // counted this and it's correct" action - the ONE other thing besides
  // a COUNT_CORRECTION movement that updates lastPhysicalCountAt. Not a
  // StockMovement (quantity hasn't changed - that's the whole point of
  // this endpoint existing separately from createMovement above), but
  // still a real, audited event. countedAt is captured as the FIRST
  // thing this handler does, before requireBranch/requireOfferVariant
  // or the transaction/lock below - so if this request has to wait
  // (e.g. a concurrent movement holding the row), the timestamp stored
  // is still the moment this employee actually read the shelf, not a
  // `now()` evaluated late after whatever it waited on.
  @BlockWhenSuspended()
  @Post(':vendorId/branches/:branchId/stock/:offerVariantId/confirm-count')
  @HttpCode(200)
  @UseInterceptors(IdempotencyInterceptor)
  async confirmPhysicalCount(
    @Param('vendorId') vendorId: string,
    @Param('branchId') branchId: string,
    @Param('offerVariantId') offerVariantId: string,
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: ConfirmPhysicalCountDto,
    @Req() req: Request,
  ) {
    const countedAt = new Date();
    await this.requireBranch(vendorId, branchId);
    const variant = await this.requireOfferVariant(vendorId, offerVariantId);

    const body = await this.prisma.$transaction(async (tx) => {
      const newStockId = randomUUID();
      // vendorId is passed explicitly from the already-validated value
      // above (requireBranch/requireOfferVariant both already proved
      // this branch and this variant belong to it) - never inferred
      // from the composite FK alone, which protects the DATABASE's own
      // integrity but would otherwise let a malformed/unvalidated input
      // reach raw SQL before any application-level check ran.
      await tx.$executeRaw`
        INSERT INTO branch_stock (id, "vendorId", "branchId", "offerVariantId", quantity, "createdAt", "updatedAt")
        VALUES (${newStockId}, ${vendorId}, ${branchId}, ${offerVariantId}, 0, now(), now())
        ON CONFLICT ("branchId", "offerVariantId") DO NOTHING
      `;
      const updated = await tx.$queryRaw<BranchStockRow[]>`
        UPDATE branch_stock
        SET "lastPhysicalCountAt" = ${countedAt}
        WHERE "branchId" = ${branchId} AND "offerVariantId" = ${offerVariantId}
        RETURNING id, "vendorId", "branchId", "offerVariantId", quantity, "reservedQuantity", "safetyStockThreshold", "lastPhysicalCountAt", "createdAt"
      `;
      const row = updated[0];

      // note (if sent) is recorded ONLY here, in the audit trail -
      // never written onto BranchStock itself (no column for it), and
      // never silently received-then-dropped either (review-round
      // fix): ConfirmPhysicalCountDto already rejected a blank one.
      await this.auditLog.record(
        {
          actorId: user.id,
          correlationId: req.correlationId,
          action: 'branch_stock.physical_count_confirmed',
          entityType: 'BranchStock',
          entityId: row.id,
          afterState: {
            ...enrichedStockDto(row, variant),
            note: dto.note ?? null,
          },
        },
        tx,
      );

      const responseBody = enrichedStockDto(row, variant);
      await this.idempotencyCompletion.complete(
        tx,
        req.idempotencyClaimId,
        responseBody,
        200,
      );
      return responseBody;
    });

    return body;
  }

  // Sprint 18a (FR-INV-007, product decision): owner-only - a safety-
  // stock threshold is a policy decision, not a day-to-day operational
  // action an employee performs (unlike recording a sale/damage, which
  // both roles may do). AuditLog is written only when the value
  // actually changes - a re-save of the same threshold (a different
  // Idempotency-Key, not a replay of the same one) is not itself an
  // event worth auditing. `FOR UPDATE` on the read closes the window
  // between reading the old value and writing the new one under
  // concurrent calls.
  @BlockWhenSuspended()
  @Put(':vendorId/branches/:branchId/stock/:offerVariantId/safety-stock')
  @HttpCode(200)
  @UseInterceptors(IdempotencyInterceptor)
  @RequireVendorRole('OWNER')
  async setSafetyStockThreshold(
    @Param('vendorId') vendorId: string,
    @Param('branchId') branchId: string,
    @Param('offerVariantId') offerVariantId: string,
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: SetSafetyStockThresholdDto,
    @Req() req: Request,
  ) {
    await this.requireBranch(vendorId, branchId);
    const variant = await this.requireOfferVariant(vendorId, offerVariantId);

    const body = await this.prisma.$transaction(async (tx) => {
      const newStockId = randomUUID();
      await tx.$executeRaw`
        INSERT INTO branch_stock (id, "vendorId", "branchId", "offerVariantId", quantity, "createdAt", "updatedAt")
        VALUES (${newStockId}, ${vendorId}, ${branchId}, ${offerVariantId}, 0, now(), now())
        ON CONFLICT ("branchId", "offerVariantId") DO NOTHING
      `;
      const existingRows = await tx.$queryRaw<BranchStockRow[]>`
        SELECT id, "vendorId", "branchId", "offerVariantId", quantity, "reservedQuantity", "safetyStockThreshold", "lastPhysicalCountAt", "createdAt"
        FROM branch_stock
        WHERE "branchId" = ${branchId} AND "offerVariantId" = ${offerVariantId}
        FOR UPDATE
      `;
      const oldThreshold = existingRows[0].safetyStockThreshold;

      const updatedRows = await tx.$queryRaw<BranchStockRow[]>`
        UPDATE branch_stock
        SET "safetyStockThreshold" = ${dto.threshold}
        WHERE "branchId" = ${branchId} AND "offerVariantId" = ${offerVariantId}
        RETURNING id, "vendorId", "branchId", "offerVariantId", quantity, "reservedQuantity", "safetyStockThreshold", "lastPhysicalCountAt", "createdAt"
      `;
      const row = updatedRows[0];

      if (oldThreshold !== dto.threshold) {
        await this.auditLog.record(
          {
            actorId: user.id,
            correlationId: req.correlationId,
            action: 'branch_stock.safety_threshold_updated',
            entityType: 'BranchStock',
            entityId: row.id,
            beforeState: { safety_stock_threshold: oldThreshold },
            afterState: { safety_stock_threshold: dto.threshold },
          },
          tx,
        );
      }

      const responseBody = enrichedStockDto(row, variant);
      await this.idempotencyCompletion.complete(
        tx,
        req.idempotencyClaimId,
        responseBody,
        200,
      );
      return responseBody;
    });

    return body;
  }
}
