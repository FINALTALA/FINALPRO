import { BlockWhenSuspended } from '../auth/vendor-suspended.guard';
import { FileInterceptor } from '@nestjs/platform-express';
import {
  BadRequestException,
  Controller,
  ForbiddenException,
  Get,
  HttpCode,
  NotFoundException,
  Param,
  Post,
  Query,
  Req,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { Request } from 'express';
import { randomUUID } from 'crypto';
import { AuditLogService } from '../audit/audit-log.service';
import { CurrentUser } from '../auth/current-user.decorator';
import { Prisma } from '../../generated/prisma/client';
import {
  AuthenticatedUser,
  SessionAuthGuard,
} from '../auth/session-auth.guard';
import { VendorMembershipGuard } from '../auth/vendor-membership.guard';
import { RequireVendorRole } from '../auth/vendor-role.decorator';
import { generateStoreInventoryBarcode } from '../common/barcode.util';
import { IdempotencyInterceptor } from '../common/idempotency/idempotency.interceptor';
import {
  isNoBrandAlias,
  NO_BRAND_SENTINEL_ID,
} from '../common/no-brand-sentinel';
import { MatchingService } from '../matching/matching.service';
import { PrismaService } from '../prisma/prisma.service';
import { SubscriptionGateService } from '../subscriptions/subscription-gate.service';
import { computeEffectivePrice } from './pricing/effective-price.util';
import { ImportReport } from './dto/import-report.dto';
import { isExpectedOfferVariantConflict } from './import/expected-offer-variant-conflict';
import {
  IMPORT_TEMPLATE_HEADERS,
  buildFailedRowsCsv,
} from './import/failed-rows-csv';
import {
  collectGroupEvidence,
  conflictingField,
  groupImportRows,
  ImportGroup,
} from './import/group-import-rows';
import { parseImportFile } from './import/parse-import-file';
import {
  validateImportRow,
  ValidatedImportRow,
} from './import/validate-import-row';

const MAX_IMPORT_ROWS = 2000;
// Review-round fix (Blocker 2): without an explicit multer `limits`,
// memory storage buffers an arbitrarily large upload in full BEFORE the
// MAX_IMPORT_ROWS check below ever runs - a resource-exhaustion vector
// independent of the multer CVE fix (that fixes a bug in multer itself,
// this sets an application resource policy multer doesn't have an
// opinion on). 10 MiB comfortably fits a 2000-row CSV/XLSX (a 2000-row
// CSV with the columns validate-import-row.ts expects is on the order
// of a few hundred KB; XLSX's zip/XML overhead is larger but still well
// under this) while bounding worst-case memory use per request.
const MAX_IMPORT_FILE_SIZE_BYTES = 10 * 1024 * 1024;

interface FailedRow {
  rowNumber: number;
  raw: Record<string, string>;
  reason: string;
}

// Sprint 7 (RB-MATCH-004): batch CSV/XLSX import - owner-only (catalog
// creation, PDR-009), reusing the exact same VendorOffer/OfferVariant
// creation rules and subscription gate the single-row JSON endpoints
// already enforce (VendorOffersController.create()/createVariant()) -
// this is the same business action, just batch-driven. No image/video
// import (RB-MATCH-004's own scope line - media stays manual-only via
// the Sprint 6 endpoints); no per-row job persistence (D6) - this
// project has no background-worker infrastructure, so the whole file is
// validated and written synchronously within the request, and the
// response IS the report.
//
// Sprint 17 (D6, blocker 3) adds ImportBatch - a durable SUMMARY only
// (counts + status, never per-row detail - see ImportBatch's own schema
// comment for its full lifecycle) - and PDR-036's category_template/
// template_attributes_json/brand_name columns. Both CSV and XLSX are
// mentioned below because parseImportFile() genuinely supports both
// today (confirmed in that file) - the failed-rows re-download,
// however, is CSV only, a deliberate simplification (not an XLSX
// writer), stated here rather than silently assumed.
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

  // Sprint 17: a static, versionless template - the exact header row
  // OFFERS_TEMPLATE_HEADERS names, nothing dynamic (no per-vendor
  // column mapping - FR-IMPORT-011 stays unbuilt, see this sprint's own
  // plan/traceability notes).
  @Get('template')
  @RequireVendorRole('OWNER')
  async downloadTemplate() {
    return { csv: IMPORT_TEMPLATE_HEADERS.join(',') + '\n' };
  }

  // Sprint 17 (D6, FR-IMPORT-004 partial): batch history - counts and
  // status only, newest first.
  @Get('batches')
  @RequireVendorRole('OWNER')
  async listBatches(
    @Param('vendorId') vendorId: string,
    @Query('limit') limitRaw?: string,
  ) {
    const limit = Math.min(Math.max(Number(limitRaw) || 20, 1), 50);
    const batches = await this.prisma.importBatch.findMany({
      where: { vendorId },
      orderBy: { createdAt: 'desc' },
      take: limit,
    });
    return batches.map((b) => ({
      id: b.id,
      file_name: b.fileName,
      status: b.status,
      total_rows: b.totalRows,
      imported_count: b.importedCount,
      skipped_count: b.skippedCount,
      invalid_count: b.invalidCount,
      conflict_count: b.conflictCount,
      created_by: b.createdBy,
      created_at: b.createdAt.toISOString(),
      completed_at: b.completedAt?.toISOString() ?? null,
    }));
  }

  @BlockWhenSuspended()
  @Post()
  @HttpCode(201)
  @UseInterceptors(
    FileInterceptor('file', {
      limits: { fileSize: MAX_IMPORT_FILE_SIZE_BYTES, files: 1 },
    }),
    IdempotencyInterceptor,
  )
  @RequireVendorRole('OWNER')
  async import(
    @Param('vendorId') vendorId: string,
    @CurrentUser() user: AuthenticatedUser,
    @UploadedFile() file: Express.Multer.File | undefined,
    @Req() req: Request,
  ): Promise<
    ImportReport & { batch_id: string; failed_rows_csv: string | null }
  > {
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

    // Sprint 17 (blocker 3): purely structural parsing, BEFORE any
    // ImportBatch row is created - a file that never even parses is not
    // a real import attempt yet, so it gets no history row at all.
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

    // Sprint 17 (D6, blocker 3): the batch row now exists, durably,
    // BEFORE any group is processed - a crash from here on is at least
    // visible as a real (if possibly stuck) PROCESSING row, never
    // silently absent. See this class's own header comment for the
    // full lifecycle and its known, disclosed limitation.
    const batch = await this.prisma.importBatch.create({
      data: {
        vendorId,
        fileName: file.originalname,
        totalRows: parsedRows.length,
        createdBy: user.id,
      },
    });

    try {
      const report: ImportReport = {
        total_rows: parsedRows.length,
        imported: [],
        skipped_already_imported: [],
        invalid_rows: [],
        conflicts: [],
      };
      const failedRows: FailedRow[] = [];

      const validRows: ValidatedImportRow[] = [];
      for (let i = 0; i < parsedRows.length; i += 1) {
        const rowNumber = i + 2; // header is row 1
        const result = validateImportRow(parsedRows[i], rowNumber);
        if ('errors' in result) {
          for (const e of result.errors) {
            report.invalid_rows.push({
              row_number: e.rowNumber,
              reason: e.reason,
            });
            failedRows.push({
              rowNumber: e.rowNumber,
              raw: parsedRows[i],
              reason: e.reason,
            });
          }
        } else {
          validRows.push(result.row);
        }
      }

      // Sprint 17 (blocker 3): resolve brand_name -> brandId in ONE
      // batched query (never per-row) - the sentinel aliases are
      // checked first (no DB round-trip needed for those), then every
      // remaining distinct name is looked up against Brand.normalizedName
      // at once. A name that resolves to neither is NEVER used to
      // create a new Brand row here - the row is moved to invalid_rows
      // with a clear reason instead (D3: "no random Brand creation").
      // The ORIGINAL brandName text is left untouched on every row -
      // groupImportRows()/conflictingField() (PDR-019's own, unrelated
      // free-text consistency check) and rowToRaw() (the failed-rows
      // CSV) both still need the real name, never an internal id.
      // Resolved ids are tracked separately, keyed by row number.
      const brandIdByName = new Map<string, string>();
      const distinctNames = [
        ...new Set(
          validRows
            .map((r) => r.brandName)
            .filter((n): n is string => n !== null && !isNoBrandAlias(n)),
        ),
      ];
      if (distinctNames.length > 0) {
        const normalize = (s: string) => s.trim().toLowerCase();
        const found = await this.prisma.brand.findMany({
          where: { normalizedName: { in: distinctNames.map(normalize) } },
        });
        const byNormalized = new Map(
          found.map((b) => [b.normalizedName, b.id]),
        );
        for (const name of distinctNames) {
          const id = byNormalized.get(normalize(name));
          if (id) brandIdByName.set(name, id);
        }
      }
      const resolvedBrandIdByRowNumber = new Map<number, string>();
      const rowsAfterBrandResolution: ValidatedImportRow[] = [];
      for (const row of validRows) {
        if (row.brandName === null) {
          rowsAfterBrandResolution.push(row);
          continue;
        }
        const resolvedBrandId = isNoBrandAlias(row.brandName)
          ? NO_BRAND_SENTINEL_ID
          : brandIdByName.get(row.brandName);
        if (!resolvedBrandId) {
          const reason = `brand_name "${row.brandName}" does not match any known brand - leave blank, use "بدون علامة تجارية", or ask a platform admin to add it via POST /brands`;
          report.invalid_rows.push({ row_number: row.rowNumber, reason });
          failedRows.push({
            rowNumber: row.rowNumber,
            raw: rowToRaw(row),
            reason,
          });
          continue;
        }
        resolvedBrandIdByRowNumber.set(row.rowNumber, resolvedBrandId);
        rowsAfterBrandResolution.push(row);
      }

      const { groups, conflicts } = groupImportRows(rowsAfterBrandResolution);
      for (const c of conflicts) {
        report.conflicts.push({ row_number: c.rowNumber, reason: c.reason });
        const row = rowsAfterBrandResolution.find(
          (r) => r.rowNumber === c.rowNumber,
        );
        if (row)
          failedRows.push({
            rowNumber: c.rowNumber,
            raw: rowToRaw(row),
            reason: c.reason,
          });
      }

      for (const group of groups) {
        await this.importGroup(
          vendorId,
          group,
          user,
          req,
          report,
          failedRows,
          resolvedBrandIdByRowNumber,
        );
      }

      await this.auditLog.record({
        actorId: user.id,
        correlationId: req.correlationId,
        action: 'vendor_offers.imported',
        entityType: 'Vendor',
        entityId: vendorId,
        afterState: {
          batch_id: batch.id,
          total_rows: report.total_rows,
          imported_count: report.imported.length,
          skipped_count: report.skipped_already_imported.length,
          invalid_count: report.invalid_rows.length,
          conflict_count: report.conflicts.length,
        },
      });

      const hasErrors =
        report.invalid_rows.length > 0 || report.conflicts.length > 0;
      await this.prisma.importBatch.update({
        where: { id: batch.id },
        data: {
          status: hasErrors ? 'COMPLETED_WITH_ERRORS' : 'COMPLETED',
          importedCount: report.imported.length,
          skippedCount: report.skipped_already_imported.length,
          invalidCount: report.invalid_rows.length,
          conflictCount: report.conflicts.length,
          completedAt: new Date(),
        },
      });

      failedRows.sort((a, b) => a.rowNumber - b.rowNumber);
      return {
        ...report,
        batch_id: batch.id,
        failed_rows_csv:
          failedRows.length > 0 ? buildFailedRowsCsv(failedRows) : null,
      };
    } catch (err) {
      // Sprint 17 (blocker 3, item 3 of the final review round): ANY
      // exception after the PROCESSING row was created - parsing was
      // already fine by construction here, so this covers a group
      // processing failure or the finalization step itself - marks the
      // batch FAILED on a best-effort basis (its own try/catch: if even
      // THIS write cannot reach the database, nothing more can be done)
      // and always re-throws the original error. Groups that already
      // committed independently before the exception stay committed -
      // partial-success is unchanged; FAILED just makes the overall
      // attempt's own outcome honest instead of silently absent.
      try {
        await this.prisma.importBatch.update({
          where: { id: batch.id },
          data: { status: 'FAILED', completedAt: new Date() },
        });
      } catch {
        // The database connection itself is unavailable - nothing more
        // can be done; the row is left at PROCESSING, a disclosed,
        // known limitation (see this class's own header comment).
      }
      throw err;
    }
  }

  private async importGroup(
    vendorId: string,
    group: ImportGroup,
    user: AuthenticatedUser,
    req: Request,
    report: ImportReport,
    failedRows: FailedRow[],
    resolvedBrandIdByRowNumber: Map<number, string>,
  ): Promise<void> {
    const rows = group.rows;
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
        const firstRow = rowsToCreate[0];
        // Review-round fix (round 4): the group's UNIFIED brand/type/mpn
        // evidence, not just firstRow's - see collectGroupEvidence()'s
        // own comment for why firstRow alone under-reported evidence
        // that a later row in the same already-conflict-checked group
        // actually provided.
        const groupEvidence = collectGroupEvidence(rows);

        // PDR-019's "same barcode + new colour/size = additive, not
        // conflict" must hold across separate import requests too, not
        // just within one file - so before deciding "new offer", check
        // whether a PRIOR import already recorded this exact (type,
        // value) for this vendor. The unique constraint on
        // ImportIdentifierRecord makes ">1 possible offer" structurally
        // impossible from THIS table alone - there is at most one
        // record per (vendor, identifierType, identifierValue). A
        // pre-existing OfferVariant with no record yet (see below) can
        // still be ambiguous, since nothing enforced that before this
        // table existed.
        let identifierRecord: {
          id: string;
          vendorOfferId: string;
          brandName: string | null;
          productType: string | null;
          mpn: string | null;
        } | null = null;
        // Round-3 review fix (Blocker 1): does this group's decision
        // require a freshly-created ImportIdentifierRecord (a
        // pre-existing OfferVariant was found, matched to exactly one
        // offer, but never had a record) rather than one already read
        // above or created for a brand-new offer below?
        let recordNeedsCreateFor: string | null = null;

        if (!offerId && group.identifierType && group.identifierValue) {
          // Round-3 review fix (Blocker 3): serialize every decision
          // for this exact (vendor, identifierType, identifierValue)
          // BEFORE reading/creating anything below - without this, two
          // concurrent imports referencing the same identifier with
          // different (valid, distinct) seller_skus could both see "no
          // record yet" and race to create one, tripping the unique
          // constraint and surfacing a misleading "seller_sku conflict"
          // for a SKU that never actually collided. Released
          // automatically at commit/rollback - no manual unlock needed
          // (same pattern as vendors.controller.ts's staff-invite lock).
          await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('finalpro:import_identifier:' || ${vendorId} || ':' || ${group.identifierType} || ':' || ${group.identifierValue}))`;

          identifierRecord = await tx.importIdentifierRecord.findUnique({
            where: {
              vendorId_identifierType_identifierValue: {
                vendorId,
                identifierType: group.identifierType,
                identifierValue: group.identifierValue,
              },
            },
          });

          if (!identifierRecord) {
            // Round-3 review fix (Blocker 1): ImportIdentifierRecord
            // starts empty for every vendor - a pre-Sprint-7 (or simply
            // not-yet-tracked) OfferVariant already carrying this exact
            // identifier must still be found and reused, or a new SKU
            // under the same real-world product would wrongly spawn a
            // second offer. brandName/productType/mpn are not stored on
            // OfferVariant (see validate-import-row.ts's own comment),
            // so there is no compatibility evidence to check on this
            // path - only whether the identifier maps to exactly one
            // existing offer.
            const legacyVariants = await tx.offerVariant.findMany({
              where: {
                vendorId,
                identifierType: group.identifierType,
                identifierValue: group.identifierValue,
              },
              select: { vendorOfferId: true },
            });
            const legacyOfferIds = Array.from(
              new Set(legacyVariants.map((v) => v.vendorOfferId)),
            );
            if (legacyOfferIds.length > 1) {
              // More than one pre-existing offer already uses this
              // identifier (possible before this table existed to
              // prevent it) - cannot prove which one this import
              // belongs to. Do not guess.
              for (const row of rowsToCreate) {
                const reason = `Multiple existing offers already use identifier_type/identifier_value "${group.identifierType}/${group.identifierValue}" for this vendor - cannot determine which to attach to, requires manual review (PDR-019)`;
                report.conflicts.push({ row_number: row.rowNumber, reason });
                failedRows.push({
                  rowNumber: row.rowNumber,
                  raw: rowToRaw(row),
                  reason,
                });
              }
              return;
            }
            if (legacyOfferIds.length === 1) {
              offerId = legacyOfferIds[0];
              recordNeedsCreateFor = offerId;
            }
          }

          if (identifierRecord) {
            const conflictField = conflictingField(
              identifierRecord,
              groupEvidence,
            );
            if (conflictField) {
              // Cannot prove compatibility with the prior import - do
              // not guess, report for manual review instead (never
              // auto-merge on unproven brand/type/mpn).
              for (const row of rowsToCreate) {
                const reason = `Conflicts with a previously imported offer sharing identifier_type/identifier_value "${group.identifierType}/${group.identifierValue}" - differing ${conflictField} requires manual review (PDR-019)`;
                report.conflicts.push({ row_number: row.rowNumber, reason });
                failedRows.push({
                  rowNumber: row.rowNumber,
                  raw: rowToRaw(row),
                  reason,
                });
              }
              return;
            }
            offerId = identifierRecord.vendorOfferId;
          }
        }

        if (!offerId) {
          // Sprint 17 (D1): the resolved brandId (or the sentinel) -
          // never a free-text name reaching the database here.
          const offer = await tx.vendorOffer.create({
            data: {
              vendorId,
              titleAr: firstRow.titleAr,
              titleEn: firstRow.titleEn,
              brandId:
                resolvedBrandIdByRowNumber.get(firstRow.rowNumber) ?? null,
              categoryTemplate: firstRow.categoryTemplate,
              templateAttributes:
                (firstRow.templateAttributes as
                  Prisma.InputJsonValue | undefined) ?? undefined,
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

          if (group.identifierType && group.identifierValue) {
            await tx.importIdentifierRecord.create({
              data: {
                vendorId,
                identifierType: group.identifierType,
                identifierValue: group.identifierValue,
                vendorOfferId: offerId,
                brandName: groupEvidence.brandName,
                productType: groupEvidence.productType,
                mpn: groupEvidence.mpn,
              },
            });
          }
        } else if (recordNeedsCreateFor === offerId) {
          await tx.importIdentifierRecord.create({
            data: {
              vendorId,
              identifierType: group.identifierType!,
              identifierValue: group.identifierValue!,
              vendorOfferId: offerId,
              brandName: groupEvidence.brandName,
              productType: groupEvidence.productType,
              mpn: groupEvidence.mpn,
            },
          });
        } else if (identifierRecord) {
          // Fill in any previously-missing brand/type/mpn now that this
          // import provides it, never overwriting a differing value -
          // conflictingField() above already proved nothing differs.
          const fillIns: Record<string, string> = {};
          if (!identifierRecord.brandName && groupEvidence.brandName) {
            fillIns.brandName = groupEvidence.brandName;
          }
          if (!identifierRecord.productType && groupEvidence.productType) {
            fillIns.productType = groupEvidence.productType;
          }
          if (!identifierRecord.mpn && groupEvidence.mpn) {
            fillIns.mpn = groupEvidence.mpn;
          }
          if (Object.keys(fillIns).length > 0) {
            await tx.importIdentifierRecord.update({
              where: { id: identifierRecord.id },
              data: fillIns,
            });
          }
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

          // Sprint 17 (blocker 1): the import-created baseline
          // PriceHistory row - reason=IMPORT, one captured `now`.
          const now = new Date();
          await tx.priceHistory.create({
            data: {
              vendorId,
              offerVariantId: variant.id,
              basePrice: variant.basePrice,
              salePrice: variant.salePrice,
              effectivePriceAtChange: computeEffectivePrice(variant, now),
              reason: 'IMPORT',
              changedBy: user.id,
              changedAt: now,
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
    } catch (err) {
      // Review-round fix (round 5): only the SPECIFIC, expected
      // OfferVariant unique-constraint race is swallowed here - a
      // concurrent import (this same file re-submitted at the same
      // instant from two requests) could still race past the pre-check
      // above and hit (vendorId, sellerSku)/(vendorId,
      // storeInventoryBarcode), reported per-row rather than failing the
      // whole request. Any OTHER P2002 (e.g. ImportIdentifierRecord's
      // own unique constraint, or any future constraint) - or any
      // non-P2002 error at all (a real DB error, an AuditLog failure, an
      // unrelated bug) - must propagate and fail the request with a
      // 500, not be guessed at: isExpectedOfferVariantConflict() checks
      // the actual Postgres constraint name against a fixed allow-list,
      // see its own comment.
      if (!isExpectedOfferVariantConflict(err)) {
        throw err;
      }
      for (const row of rowsToCreate) {
        const reason =
          'Could not import this row - it may have just been imported concurrently (seller_sku conflict)';
        report.invalid_rows.push({ row_number: row.rowNumber, reason });
        failedRows.push({
          rowNumber: row.rowNumber,
          raw: rowToRaw(row),
          reason,
        });
      }
    }
  }
}

/** Reconstructs a raw, re-uploadable row record from an already-
 * validated row (used for conflict/brand-resolution failures, which
 * never had their original raw text retained past validation). */
function rowToRaw(row: ValidatedImportRow): Record<string, string> {
  return {
    title_ar: row.titleAr,
    title_en: row.titleEn,
    seller_sku: row.sellerSku,
    base_price: String(row.basePrice),
    sale_price: row.salePrice !== null ? String(row.salePrice) : '',
    condition: row.condition,
    specs_text_ar: row.specsTextAr ?? '',
    specs_text_en: row.specsTextEn ?? '',
    identifier_type: row.identifierType ?? '',
    identifier_value: row.identifierValue ?? '',
    store_inventory_barcode: row.storeInventoryBarcode ?? '',
    brand_name: row.brandName ?? '',
    product_type: row.productType ?? '',
    mpn: row.mpn ?? '',
    category_template: row.categoryTemplate ?? '',
    template_attributes_json: row.templateAttributes
      ? JSON.stringify(row.templateAttributes)
      : '',
  };
}
