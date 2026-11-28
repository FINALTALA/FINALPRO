import {
  Controller,
  Get,
  Head,
  HttpCode,
  NotFoundException,
  Param,
  Post,
  Query,
  Req,
  Res,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { PlatformRole } from '../../generated/prisma/client';
import { CurrentUser } from '../auth/current-user.decorator';
import { RequirePlatformRole } from '../auth/platform-role.decorator';
import { PlatformRoleGuard } from '../auth/platform-role.guard';
import {
  AuthenticatedUser,
  SessionAuthGuard,
} from '../auth/session-auth.guard';
import { IdempotencyInterceptor } from '../common/idempotency/idempotency.interceptor';
import { PrismaService } from '../prisma/prisma.service';
import { MediaLibraryService } from './media-library.service';
import { keyPath, sendMediaFile, verifyPreview } from './media-storage';

/** VIA phase 5 - Media Library administration (PLATFORM_ADMIN only). */
@Controller('admin/media')
@UseGuards(SessionAuthGuard, PlatformRoleGuard)
export class AdminMediaController {
  constructor(private readonly media: MediaLibraryService) {}

  @Get()
  @RequirePlatformRole(PlatformRole.PLATFORM_ADMIN)
  list(
    @Query('q') q?: string,
    @Query('category') category?: string,
    @Query('kind') kind?: string,
    @Query('status') status?: string,
    @Query('cursor') cursor?: string,
    @Query('limit') limit?: string,
  ) {
    return this.media.list({ q, category, kind, status, cursor, limit });
  }

  /** multipart/form-data with one "file" part; ?category=HOMEPAGE|TRENDING|ADS|COLLECTIONS&name=... */
  @Post()
  @RequirePlatformRole(PlatformRole.PLATFORM_ADMIN)
  @HttpCode(201)
  upload(
    @Req() req: Request,
    @CurrentUser() user: AuthenticatedUser,
    @Query('category') category?: string,
    @Query('name') name?: string,
  ) {
    return this.media.upload(req, user.id, category, name, req.correlationId);
  }

  @Get(':id')
  @RequirePlatformRole(PlatformRole.PLATFORM_ADMIN)
  detail(@Param('id') id: string) {
    return this.media.detail(id);
  }

  @Post(':id/archive')
  @RequirePlatformRole(PlatformRole.PLATFORM_ADMIN)
  @UseInterceptors(IdempotencyInterceptor)
  @HttpCode(201)
  archive(
    @Param('id') id: string,
    @CurrentUser() user: AuthenticatedUser,
    @Req() req: Request,
  ) {
    return this.media.archive(id, user.id, req.correlationId);
  }

  @Post(':id/restore')
  @RequirePlatformRole(PlatformRole.PLATFORM_ADMIN)
  @UseInterceptors(IdempotencyInterceptor)
  @HttpCode(201)
  restore(
    @Param('id') id: string,
    @CurrentUser() user: AuthenticatedUser,
    @Req() req: Request,
  ) {
    return this.media.restore(id, user.id, req.correlationId);
  }

  @Post(':id/purge')
  @RequirePlatformRole(PlatformRole.PLATFORM_ADMIN)
  @UseInterceptors(IdempotencyInterceptor)
  @HttpCode(201)
  purge(
    @Param('id') id: string,
    @CurrentUser() user: AuthenticatedUser,
    @Req() req: Request,
  ) {
    return this.media.purge(id, user.id, req.correlationId);
  }
}

/**
 * Delivery. No session here (an <img>/<video> cannot send one):
 *  - previews of any valid asset need a short-lived signature that only
 *    the admin API hands out (detail/list), so unpublished media stays
 *    admin-only;
 *  - a published asset (a PUBLISHED MediaUsage) is served at an immutable
 *    URL carrying its content hash.
 * Both: the validated content type, nosniff, single byte ranges.
 */
@Controller('media')
export class MediaDeliveryController {
  constructor(private readonly prisma: PrismaService) {}

  private async asset(id: string) {
    const a = await this.prisma.mediaAsset.findFirst({
      where: { id, validationState: 'VALID', status: { not: 'PURGING' } },
      select: {
        id: true,
        storageKey: true,
        mimeType: true,
        sizeBytes: true,
        sha256: true,
      },
    });
    if (!a)
      throw new NotFoundException({
        code: 'MEDIA_NOT_FOUND',
        message: 'Not found',
      });
    return a;
  }

  @Get('preview/:id')
  @Head('preview/:id')
  async preview(
    @Param('id') id: string,
    @Query('exp') exp: string,
    @Query('sig') sig: string,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    if (!verifyPreview(id, exp, sig))
      throw new NotFoundException({
        code: 'MEDIA_NOT_FOUND',
        message: 'Not found',
      });
    const a = await this.asset(id);
    await sendMediaFile(
      req,
      res,
      keyPath(a.storageKey!),
      a.mimeType!,
      a.sizeBytes!,
      'private, no-store',
    );
  }

  @Get('p/:id/:file')
  @Head('p/:id/:file')
  async published(
    @Param('id') id: string,
    @Param('file') file: string,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    const a = await this.asset(id);
    const ext = a.storageKey!.split('.').pop();
    const published = await this.prisma.mediaUsage.count({
      where: { assetId: id, state: 'PUBLISHED' },
    });
    if (published === 0 || file !== `${a.sha256!.slice(0, 16)}.${ext}`) {
      throw new NotFoundException({
        code: 'MEDIA_NOT_FOUND',
        message: 'Not found',
      });
    }
    await sendMediaFile(
      req,
      res,
      keyPath(a.storageKey!),
      a.mimeType!,
      a.sizeBytes!,
      'public, max-age=31536000, immutable',
    );
  }
}
