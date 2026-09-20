import { FileInterceptor } from '@nestjs/platform-express';
import {
  BadRequestException,
  Controller,
  ForbiddenException,
  HttpCode,
  NotFoundException,
  Param,
  Post,
  Req,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { Request } from 'express';
import { randomUUID } from 'crypto';
import { AuditLogService } from '../audit/audit-log.service';
import { CurrentUser } from '../auth/current-user.decorator';
import {
  AuthenticatedUser,
  SessionAuthGuard,
} from '../auth/session-auth.guard';
import { VendorMembershipGuard } from '../auth/vendor-membership.guard';
import { RequireVendorRole } from '../auth/vendor-role.decorator';
import { generateStoreInventoryBarcode } from '../common/barcode.util';
import { IdempotencyInterceptor } from '../common/idempotency/idempotency.interceptor';
import { MatchingService } from '../matching/matching.service';
import { PrismaService } from '../prisma/prisma.service';
import { SubscriptionGateService } from '../subscriptions/subscription-gate.service';
import { ImportReport } from './dto/import-report.dto';
import { groupImportRows } from './import/group-import-rows';
import { parseImportFile } from './import/parse-import-file';
import {
  ValidatedImportRow,
  validateImportRow,
} from './import/validate-import-row';

const MAX_IMPORT_ROWS = 2000;

// Sprint 7 (RB-MATCH-004): batch CSV/XLSX import - owner-only (catalog
// creation, PDR-009), reusing the exact same VendorOffer/OfferVariant
// creation rules and subscription gate the single-row JSON endpoints
// already enforce (VendorOffersController.create()/createVariant()) -
// this is the same business action, just batch-driven. No image/video
// import (RB-MATCH-004's own scope line - media stays manual-only via
// the Sprint 6 endpoints); no ImportJob persistence - this project has
// no background-worker infrastructure, so the whole file is validated
// and written synchronously within the request, and the response IS
// the report (nothing to poll for later).
// @RequireVendorRole is applied on the @Post() method below, not here -
// VendorMembershipGuard reads it via Reflector.get(KEY,
// context.getHandler()), which never sees a class-level decorator (the
// same requirement already documented, and already gotten wrong once
// each, on VendorOffersController/SubscriptionsController - see their
// own comments).
@Controller('vendors/:vendorId/offers/import')
@UseGuards(SessionAuthGuard, VendorMembershipGuard)
export class OffersImportController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auditLog: AuditLogService,
    private readonly matching: MatchingService,
    private readonly subscriptionGate: SubscriptionGateService,
  ) {}

  @Post()
  @HttpCode(201)
  @UseInterceptors(FileInterceptor('file'), IdempotencyInterceptor)
  @RequireVendorRole('OWNER')
  async import(
    @Param('vendorId') vendorId: string,
    @CurrentUser() user: AuthenticatedUser,
    @UploadedFile() file: Express.Multer.File | undefined,
    @Req() req: Request,
  ): Promise<ImportReport> {
    if (!file) {
      throw new BadRequestException({
        code: 'FILE_REQUIRED',
        message: 'A CSV or XLSX file must be uploaded under the "file" field',
      });
    }

    const vendorExists = await this.prisma.vendor.findUnique({
      where: { id: vendorId },
    });
    if (!vendorExists) {
      throw new NotFoundException({
        code: 'VENDOR_NOT_FOUND',
        message: 'Vendor not found',
      });
    }

    // Same FR-VEND-004/BR-014 gate as VendorOffersController.create() -
    // import creates the exact same kind of resource, so it is gated
    // the exact same way.
    const subscriptionStatus = await this.prisma.$transaction((tx) =>
      this.subscriptionGate.refreshStatus(tx, vendorId, req.correlationId),
    );
    if (subscriptionStatus !== 'ACTIVE') {
      throw new ForbiddenException({
        code: 'SUBSCRIPTION_INACTIVE',
        message: 'An active subscription is required before importing offers',
      });
    }

    let parsedRows: Record<string, string>[];
    try {
      parsedRows = await parseImportFile(file.buffer, file.originalname);
    } catch {
      throw new BadRequestException({
        code: 'UNSUPPORTED_FILE_TYPE',
        message: 'Only .csv and .xlsx files are supported',
      });
    }
    if (parsedRows.length > MAX_IMPORT_ROWS) {
      throw new BadRequestException({
        code: 'IMPORT_FILE_TOO_LARGE',
        message: `A single import is limited to ${MAX_IMPORT_ROWS} rows`,
      });
    }

    const report: ImportReport = {
      total_rows: parsedRows.length,
      imported: [],
      skipped_already_imported: [],
      invalid_rows: [],
      conflicts: [],
    };

    const validRows = [];
    for (let i = 0; i < parsedRows.length; i += 1) {
      const rowNumber = i + 2; // header is row 1
      const result = validateImportRow(parsedRows[i], rowNumber);
      if ('errors' in result) {
        report.invalid_rows.push(
          ...result.errors.map((e) => ({
            row_number: e.rowNumber,
            reason: e.reason,
          })),
        );
      } else {
        validRows.push(result.row);
      }
    }

    const { groups, conflicts } = groupImportRows(validRows);
    report.conflicts.push(
      ...conflicts.map((c) => ({ row_number: c.rowNumber, reason: c.reason })),
    );

    for (const group of groups) {
      await this.importGroup(vendorId, group.rows, user, req, report);
    }

    await this.auditLog.record({
      actorId: user.id,
      correlationId: req.correlationId,
      action: 'vendor_offers.imported',
      entityType: 'Vendor',
      entityId: vendorId,
      afterState: {
        total_rows: report.total_rows,
        imported_count: report.imported.length,
        skipped_count: report.skipped_already_imported.length,
        invalid_count: report.invalid_rows.length,
        conflict_count: report.conflicts.length,
      },
    });

    return report;
  }

  private async importGroup(
    vendorId: string,
    rows: ValidatedImportRow[],
    user: AuthenticatedUser,
    req: Request,
    report: ImportReport,
  ): Promise<void> {
    const existingVariants = await this.prisma.offerVariant.findMany({
      where: { vendorId, sellerSku: { in: rows.map((r) => r.sellerSku) } },
    });
    const existingBySku = new Map(
      existingVariants.map((v) => [v.sellerSku, v]),
    );

    for (const row of rows) {
      const existing = existingBySku.get(row.sellerSku);
      if (existing) {
        report.skipped_already_imported.push({
          row_number: row.rowNumber,
          reason: `seller_sku "${row.sellerSku}" already exists for this vendor - not re-imported`,
          offer_id: existing.vendorOfferId,
        });
      }
    }

    const rowsToCreate = rows.filter((r) => !existingBySku.has(r.sellerSku));
    if (rowsToCreate.length === 0) {
      return;
    }

    const reuseOfferId = rows
      .map((r) => existingBySku.get(r.sellerSku))
      .find((v) => v)?.vendorOfferId;

    try {
      await this.prisma.$transaction(async (tx) => {
        let offerId = reuseOfferId;
        if (!offerId) {
          const firstRow = rowsToCreate[0];
          const offer = await tx.vendorOffer.create({
            data: {
              vendorId,
              titleAr: firstRow.titleAr,
              titleEn: firstRow.titleEn,
            },
          });
          offerId = offer.id;
          await this.auditLog.record(
            {
              actorId: user.id,
              correlationId: req.correlationId,
              action: 'vendor_offer.created',
              entityType: 'VendorOffer',
              entityId: offer.id,
              afterState: { title_ar: offer.titleAr, title_en: offer.titleEn },
            },
            tx,
          );
        }

        for (const row of rowsToCreate) {
          let proposedCanonicalVariantId: string | null = null;
          if (row.identifierType && row.identifierValue) {
            const match = await this.matching.findExactMatch(
              row.identifierType,
              row.identifierValue,
              tx,
            );
            proposedCanonicalVariantId = match.canonicalVariantId;
          }

          const variantId = randomUUID();
          const variant = await tx.offerVariant.create({
            data: {
              id: variantId,
              vendorId,
              vendorOfferId: offerId,
              proposedCanonicalVariantId,
              matchProposalStatus: proposedCanonicalVariantId
                ? 'PENDING'
                : 'NONE',
              sellerSku: row.sellerSku,
              condition: row.condition,
              basePrice: row.basePrice,
              salePrice: row.salePrice,
              specsTextAr: row.specsTextAr,
              specsTextEn: row.specsTextEn,
              identifierType: row.identifierType,
              identifierValue: row.identifierValue,
              storeInventoryBarcode:
                row.storeInventoryBarcode ??
                generateStoreInventoryBarcode(variantId),
            },
          });

          await this.auditLog.record(
            {
              actorId: user.id,
              correlationId: req.correlationId,
              action: proposedCanonicalVariantId
                ? 'offer_variant.match_proposed'
                : 'offer_variant.created',
              entityType: 'OfferVariant',
              entityId: variant.id,
              afterState: { seller_sku: variant.sellerSku, imported: true },
            },
            tx,
          );

          report.imported.push({
            row_number: row.rowNumber,
            offer_id: offerId,
            variant_id: variant.id,
          });
        }
      });
    } catch {
      // Defensive only: a concurrent import (this same file re-submitted
      // at the same instant from two requests) could still race past
      // the pre-check above and hit the (vendorId, sellerSku) unique
      // constraint inside the transaction - reported per-row rather
      // than failing the whole request.
      for (const row of rowsToCreate) {
        report.invalid_rows.push({
          row_number: row.rowNumber,
          reason:
            'Could not import this row - it may have just been imported concurrently (seller_sku conflict)',
        });
      }
    }
  }
}
