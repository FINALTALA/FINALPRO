import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  Post,
  Put,
  Query,
  Req,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import type { Request } from 'express';
import { PlatformRole } from '../../generated/prisma/client';
import { CurrentUser } from '../auth/current-user.decorator';
import { RequirePlatformRole } from '../auth/platform-role.decorator';
import { PlatformRoleGuard } from '../auth/platform-role.guard';
import {
  AuthenticatedUser,
  SessionAuthGuard,
} from '../auth/session-auth.guard';
import { IdempotencyInterceptor } from '../common/idempotency/idempotency.interceptor';
import { ContentStudioService, parsePage } from './content-studio.service';

// Not named "Body": that would shadow the @Body decorator in the emitted
// parameter metadata and the global whitelist would strip every field.
type Payload = Record<string, unknown>;

/** VIA phase 6 - Content Studio administration (PLATFORM_ADMIN only, incl. previews). */
@Controller('admin/content')
@UseGuards(SessionAuthGuard, PlatformRoleGuard)
export class AdminContentController {
  constructor(private readonly content: ContentStudioService) {}

  @Get()
  @RequirePlatformRole(PlatformRole.PLATFORM_ADMIN)
  overview() {
    return this.content.overview();
  }

  @Get('registry')
  @RequirePlatformRole(PlatformRole.PLATFORM_ADMIN)
  registry() {
    return { ...this.content.registry(), ...this.content.localNow() };
  }

  @Get(':page')
  @RequirePlatformRole(PlatformRole.PLATFORM_ADMIN)
  detail(@Param('page') page: string) {
    return this.content.detail(parsePage(page));
  }

  @Get(':page/preview')
  @RequirePlatformRole(PlatformRole.PLATFORM_ADMIN)
  preview(@Param('page') page: string, @Query('revision') revision?: string) {
    return this.content.preview(parsePage(page), revision || undefined);
  }

  @Post(':page/import')
  @RequirePlatformRole(PlatformRole.PLATFORM_ADMIN)
  @UseInterceptors(IdempotencyInterceptor)
  @HttpCode(201)
  importCurrent(
    @Param('page') page: string,
    @Body() body: Payload,
    @CurrentUser() u: AuthenticatedUser,
    @Req() req: Request,
  ) {
    return this.content.importCurrent(
      parsePage(page),
      body.document,
      u.id,
      req.correlationId,
    );
  }

  @Put(':page/draft')
  @RequirePlatformRole(PlatformRole.PLATFORM_ADMIN)
  saveDraft(
    @Param('page') page: string,
    @Body() body: Payload,
    @CurrentUser() u: AuthenticatedUser,
    @Req() req: Request,
  ) {
    return this.content.saveDraft(
      parsePage(page),
      body.version,
      body.document,
      u.id,
      req.correlationId,
    );
  }

  @Post(':page/publish')
  @RequirePlatformRole(PlatformRole.PLATFORM_ADMIN)
  @UseInterceptors(IdempotencyInterceptor)
  @HttpCode(201)
  publish(
    @Param('page') page: string,
    @Body() body: Payload,
    @CurrentUser() u: AuthenticatedUser,
    @Req() req: Request,
  ) {
    return this.content.publish(
      parsePage(page),
      body.version,
      u.id,
      req.correlationId,
    );
  }

  @Post(':page/unpublish')
  @RequirePlatformRole(PlatformRole.PLATFORM_ADMIN)
  @UseInterceptors(IdempotencyInterceptor)
  @HttpCode(201)
  unpublish(
    @Param('page') page: string,
    @CurrentUser() u: AuthenticatedUser,
    @Req() req: Request,
  ) {
    return this.content.unpublish(parsePage(page), u.id, req.correlationId);
  }

  @Post(':page/schedule')
  @RequirePlatformRole(PlatformRole.PLATFORM_ADMIN)
  @UseInterceptors(IdempotencyInterceptor)
  @HttpCode(201)
  schedule(
    @Param('page') page: string,
    @Body() body: Payload,
    @CurrentUser() u: AuthenticatedUser,
    @Req() req: Request,
  ) {
    return this.content.schedule(
      parsePage(page),
      body,
      u.id,
      req.correlationId,
    );
  }

  @Post(':page/schedule/cancel')
  @RequirePlatformRole(PlatformRole.PLATFORM_ADMIN)
  @UseInterceptors(IdempotencyInterceptor)
  @HttpCode(201)
  cancel(
    @Param('page') page: string,
    @CurrentUser() u: AuthenticatedUser,
    @Req() req: Request,
  ) {
    return this.content.cancelSchedule(
      parsePage(page),
      u.id,
      req.correlationId,
    );
  }

  @Post(':page/schedules/:id/retry')
  @RequirePlatformRole(PlatformRole.PLATFORM_ADMIN)
  @UseInterceptors(IdempotencyInterceptor)
  @HttpCode(201)
  retry(
    @Param('page') page: string,
    @Param('id') id: string,
    @CurrentUser() u: AuthenticatedUser,
  ) {
    return this.content.retrySchedule(parsePage(page), id, u.id);
  }

  @Post(':page/revisions/:id/restore')
  @RequirePlatformRole(PlatformRole.PLATFORM_ADMIN)
  @UseInterceptors(IdempotencyInterceptor)
  @HttpCode(201)
  restore(
    @Param('page') page: string,
    @Param('id') id: string,
    @CurrentUser() u: AuthenticatedUser,
    @Req() req: Request,
  ) {
    return this.content.restore(parsePage(page), id, u.id, req.correlationId);
  }

  @Post(':page/revisions/:id/load-draft')
  @RequirePlatformRole(PlatformRole.PLATFORM_ADMIN)
  @UseInterceptors(IdempotencyInterceptor)
  @HttpCode(201)
  loadDraft(
    @Param('page') page: string,
    @Param('id') id: string,
    @Body() body: Payload,
    @CurrentUser() u: AuthenticatedUser,
    @Req() req: Request,
  ) {
    return this.content.loadIntoDraft(
      parsePage(page),
      id,
      body.version,
      u.id,
      req.correlationId,
    );
  }

  @Post(':page/revisions/:id/archive')
  @RequirePlatformRole(PlatformRole.PLATFORM_ADMIN)
  @UseInterceptors(IdempotencyInterceptor)
  @HttpCode(201)
  archive(
    @Param('page') page: string,
    @Param('id') id: string,
    @CurrentUser() u: AuthenticatedUser,
    @Req() req: Request,
  ) {
    return this.content.archiveRevision(
      parsePage(page),
      id,
      u.id,
      req.correlationId,
    );
  }
}

/** The live content of a page (public, no session). */
@Controller('content')
export class PublicContentController {
  constructor(private readonly content: ContentStudioService) {}

  @Get(':page')
  view(@Param('page') page: string) {
    return this.content.publicView(parsePage(page));
  }
}
