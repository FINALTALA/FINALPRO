import {
  BadRequestException,
  Controller,
  HttpCode,
  NotFoundException,
  Param,
  Post,
  Req,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { randomBytes } from 'crypto';
import { Request } from 'express';
import { mkdir, writeFile } from 'fs/promises';
import * as path from 'path';
import { AuditLogService } from '../audit/audit-log.service';
import { CurrentUser } from '../auth/current-user.decorator';
import {
  AuthenticatedUser,
  SessionAuthGuard,
} from '../auth/session-auth.guard';
import { VendorMembershipGuard } from '../auth/vendor-membership.guard';
import { BlockWhenSuspended } from '../auth/vendor-suspended.guard';
import { RequireVendorRole } from '../auth/vendor-role.decorator';
import { PrismaService } from '../prisma/prisma.service';
import { imageDimensions } from './image-dimensions.util';
import {
  MAX_UPLOAD_BYTES,
  ownUploadUrl,
  sniffImage,
  uploadsDir,
} from './uploads.util';

// Sprint 26: owner-only image upload. It only stores the file and
// returns its URL - attaching it (store logo/cover via PUT storefront,
// a product photo via POST .../media) goes through those existing
// endpoints, so their own validation, limits and audit trail still
// apply unchanged. Memory storage with an explicit size cap (same
// policy as the offers import), and the type is decided by the file's
// own bytes, never by the client.
@Controller('vendors/:vendorId/uploads')
@UseGuards(SessionAuthGuard, VendorMembershipGuard)
export class UploadsController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auditLog: AuditLogService,
  ) {}

  @BlockWhenSuspended()
  @Post()
  @HttpCode(201)
  @UseInterceptors(
    FileInterceptor('file', {
      limits: { fileSize: MAX_UPLOAD_BYTES, files: 1 },
    }),
  )
  @RequireVendorRole('OWNER')
  async upload(
    @Param('vendorId') vendorId: string,
    @CurrentUser() user: AuthenticatedUser,
    @UploadedFile() file: Express.Multer.File | undefined,
    @Req() req: Request,
  ) {
    if (!file) {
      throw new BadRequestException({
        code: 'FILE_REQUIRED',
        message: 'An image must be uploaded under the "file" field',
      });
    }
    const image = sniffImage(file.buffer);
    if (!image) {
      throw new BadRequestException({
        code: 'UNSUPPORTED_IMAGE_TYPE',
        message: 'Only JPEG, PNG, WebP or GIF images can be uploaded',
      });
    }
    const vendor = await this.prisma.vendor.findUnique({
      where: { id: vendorId },
      select: { id: true },
    });
    if (!vendor) {
      throw new NotFoundException({
        code: 'VENDOR_NOT_FOUND',
        message: 'Vendor not found',
      });
    }

    const name = `${randomBytes(16).toString('hex')}.${image.ext}`;
    const dir = path.join(uploadsDir(), 'vendors', vendorId);
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, name), file.buffer, { flag: 'wx' });

    const url = ownUploadUrl(vendorId, name);
    // Phase A++ (item 6): the image's size, read by the server (no
    // re-encoding) - the wizard warns about a small or far-from-3:4 image
    // but never refuses it. null when it cannot be read.
    const dims = await imageDimensions(file.buffer);
    await this.auditLog.record({
      actorId: user.id,
      correlationId: req.correlationId,
      action: 'vendor.image_uploaded',
      entityType: 'Vendor',
      entityId: vendorId,
      afterState: { url, content_type: image.mime, size_bytes: file.size },
    });
    return {
      url,
      content_type: image.mime,
      size_bytes: file.size,
      width: dims?.width ?? null,
      height: dims?.height ?? null,
    };
  }
}
