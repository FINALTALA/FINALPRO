import {
  BadRequestException,
  Body,
  Controller,
  ForbiddenException,
  Get,
  HttpCode,
  Param,
  Post,
  Put,
  Query,
  Req,
  Res,
  UploadedFiles,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileFieldsInterceptor } from '@nestjs/platform-express';
import { randomBytes } from 'crypto';
import { Request, Response } from 'express';
import { mkdirSync } from 'fs';
import { rm } from 'fs/promises';
import { diskStorage } from 'multer';
import { CurrentUser } from '../auth/current-user.decorator';
import {
  AuthenticatedUser,
  SessionAuthGuard,
} from '../auth/session-auth.guard';
import { VendorMembershipGuard } from '../auth/vendor-membership.guard';
import { RequireVendorRole } from '../auth/vendor-role.decorator';
import { BlockWhenSuspended } from '../auth/vendor-suspended.guard';
import { PrismaService } from '../prisma/prisma.service';
import { SubscriptionGateService } from '../subscriptions/subscription-gate.service';
import { incomingDir, MAX_ZIP_BYTES } from './import-images';
import {
  ConfirmProductImportDto,
  ImportBarcodeDto,
  ImportGenerateBarcodesDto,
} from './product-import.dto';
import { ProductImportService } from './product-import.service';

/**
 * Both files go to the PRIVATE incoming folder under random names (never
 * the client's), never into memory as a whole and never under the public
 * uploads; each is removed when the request ends, whatever happens.
 */
const incoming = diskStorage({
  destination: (_req, _file, cb) => {
    const dir = incomingDir();
    mkdirSync(dir, { recursive: true });
    cb(null, dir);
  },
  filename: (_req, _file, cb) => cb(null, randomBytes(16).toString('hex')),
});

/**
 * The product import (2026-11-18): the store's XLSX template, checking a
 * file with the ZIP of its images (creates nothing), confirming the chosen products as drafts (all
 * or none), and the recent imports. Owner only; checking and confirming
 * need an active subscription and an unsuspended store, like creating a
 * product. The older flat import (offers/import) stays for compatibility
 * but is no longer offered to owners.
 */
@Controller('vendors/:vendorId/product-import')
@UseGuards(SessionAuthGuard, VendorMembershipGuard)
export class ProductImportController {
  constructor(
    private readonly service: ProductImportService,
    private readonly subscriptionGate: SubscriptionGateService,
    private readonly prisma: PrismaService,
  ) {}

  private async requireSubscription(vendorId: string, req: Request) {
    const status = await this.prisma.$transaction((tx) =>
      this.subscriptionGate.refreshStatus(tx, vendorId, req.correlationId),
    );
    if (status !== 'ACTIVE') {
      throw new ForbiddenException({
        code: 'SUBSCRIPTION_INACTIVE',
        message: 'An active subscription is required before importing products',
      });
    }
  }

  @Get('template')
  @RequireVendorRole('OWNER')
  async template(
    @Param('vendorId') vendorId: string,
    @Query('lang') lang: string | undefined,
    @Res() res: Response,
  ) {
    const l = lang === 'en' ? 'en' : 'ar';
    const buffer = await this.service.template(vendorId, l);
    const name =
      l === 'en'
        ? 'products-import-template.xlsx'
        : 'قالب-استيراد-المنتجات.xlsx';
    res.setHeader(
      'Content-Type',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    );
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="products-import-template.xlsx"; filename*=UTF-8''${encodeURIComponent(name)}`,
    );
    res.send(buffer);
  }

  @BlockWhenSuspended()
  @Post('check')
  @HttpCode(200)
  @RequireVendorRole('OWNER')
  @UseInterceptors(
    FileFieldsInterceptor(
      [
        { name: 'file', maxCount: 1 },
        { name: 'images', maxCount: 1 },
      ],
      {
        storage: incoming,
        // the ZIP's limit; the .xlsx (5 MB) is checked on its own
        limits: { fileSize: MAX_ZIP_BYTES, files: 2, fields: 4, parts: 6 },
      },
    ),
  )
  async check(
    @Param('vendorId') vendorId: string,
    @CurrentUser() user: AuthenticatedUser,
    @UploadedFiles()
    files: { file?: Express.Multer.File[]; images?: Express.Multer.File[] },
    @Req() req: Request,
  ) {
    const file = files?.file?.[0];
    const zip = files?.images?.[0] ?? null;
    try {
      if (!file) {
        throw new BadRequestException({
          code: 'FILE_REQUIRED',
          message: 'An .xlsx file must be uploaded under the "file" field',
        });
      }
      await this.requireSubscription(vendorId, req);
      return await this.service.check(
        vendorId,
        user.id,
        req.correlationId,
        file,
        zip,
      );
    } finally {
      for (const f of [file, zip])
        if (f?.path) await rm(f.path, { force: true }).catch(() => undefined);
    }
  }

  @BlockWhenSuspended()
  @Post(':batchId/confirm')
  @HttpCode(201)
  @RequireVendorRole('OWNER')
  async confirm(
    @Param('vendorId') vendorId: string,
    @Param('batchId') batchId: string,
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: ConfirmProductImportDto,
    @Req() req: Request,
  ) {
    await this.requireSubscription(vendorId, req);
    return this.service.confirm(
      vendorId,
      user.id,
      req.correlationId,
      batchId,
      dto,
    );
  }

  /** A product's barcode typed or scanned on the check (before any draft). */
  @BlockWhenSuspended()
  @Put(':batchId/products/:ref/barcode')
  @RequireVendorRole('OWNER')
  async setBarcode(
    @Param('vendorId') vendorId: string,
    @Param('batchId') batchId: string,
    @Param('ref') ref: string,
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: ImportBarcodeDto,
    @Req() req: Request,
  ) {
    await this.requireSubscription(vendorId, req);
    return this.service.setBarcode(
      vendorId,
      user.id,
      req.correlationId,
      batchId,
      ref,
      dto.code,
    );
  }

  /** System barcodes for the chosen products of the check that still need one. */
  @BlockWhenSuspended()
  @Post(':batchId/barcodes/generate')
  @HttpCode(200)
  @RequireVendorRole('OWNER')
  async generateBarcodes(
    @Param('vendorId') vendorId: string,
    @Param('batchId') batchId: string,
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: ImportGenerateBarcodesDto,
    @Req() req: Request,
  ) {
    await this.requireSubscription(vendorId, req);
    return this.service.generateBarcodes(
      vendorId,
      user.id,
      req.correlationId,
      batchId,
      dto.refs,
    );
  }

  @Get('batches')
  @RequireVendorRole('OWNER')
  async batches(@Param('vendorId') vendorId: string) {
    return this.service.list(vendorId);
  }

  /** One import's own drafts (paged) and what was not created - the batch's screen. */
  @Get(':batchId')
  @RequireVendorRole('OWNER')
  async batch(
    @Param('vendorId') vendorId: string,
    @Param('batchId') batchId: string,
    @Query('page') page?: string,
    @Query('page_size') pageSize?: string,
  ) {
    return this.service.batchView(
      vendorId,
      batchId,
      Number(page) || 1,
      Number(pageSize) || 24,
    );
  }

  /**
   * A ready product's main image while its check is valid - this store
   * only, a small private copy (never the staged file, never a public URL).
   */
  @Get(':batchId/thumbnails/:ref')
  @RequireVendorRole('OWNER')
  async thumbnail(
    @Param('vendorId') vendorId: string,
    @Param('batchId') batchId: string,
    @Param('ref') ref: string,
    @Res() res: Response,
  ) {
    const image = await this.service.thumbnail(vendorId, batchId, ref);
    res.setHeader('Content-Type', 'image/webp');
    res.setHeader('Cache-Control', 'private, no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.send(image);
  }
}
