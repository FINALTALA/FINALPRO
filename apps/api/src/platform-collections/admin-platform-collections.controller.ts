import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Put,
  Req,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { Request } from 'express';
import { PlatformRole } from '../../generated/prisma/client';
import { CurrentUser } from '../auth/current-user.decorator';
import { RequirePlatformRole } from '../auth/platform-role.decorator';
import { PlatformRoleGuard } from '../auth/platform-role.guard';
import {
  AuthenticatedUser,
  SessionAuthGuard,
} from '../auth/session-auth.guard';
import { IdempotencyInterceptor } from '../common/idempotency/idempotency.interceptor';
import {
  CreatePlatformCollectionDto,
  OrderCollectionsDto,
  SetCollectionItemsDto,
  UpdatePlatformCollectionDto,
} from './dto/platform-collection.dto';
import { PlatformCollectionsService } from './platform-collections.service';

const uuid = new ParseUUIDPipe({ version: '4' });

// PD-5b.1: platform editorial collections - PLATFORM_ADMIN only (a store
// owner, an employee or a customer gets 403; a guest 401). Every write
// needs an Idempotency-Key and is audited. No public read yet (PD-5b.2).
@Controller('admin/collections')
@UseGuards(SessionAuthGuard, PlatformRoleGuard)
export class AdminPlatformCollectionsController {
  constructor(private readonly collections: PlatformCollectionsService) {}

  @Get()
  @RequirePlatformRole(PlatformRole.PLATFORM_ADMIN)
  list() {
    return this.collections.list();
  }

  @Post()
  @RequirePlatformRole(PlatformRole.PLATFORM_ADMIN)
  @UseInterceptors(IdempotencyInterceptor)
  create(
    @Body() dto: CreatePlatformCollectionDto,
    @CurrentUser() user: AuthenticatedUser,
    @Req() req: Request,
  ) {
    return this.collections.create(user.id, req.correlationId, dto);
  }

  // Declared before ':id' so "order" is never read as an id.
  @Put('order')
  @RequirePlatformRole(PlatformRole.PLATFORM_ADMIN)
  @UseInterceptors(IdempotencyInterceptor)
  order(
    @Body() dto: OrderCollectionsDto,
    @CurrentUser() user: AuthenticatedUser,
    @Req() req: Request,
  ) {
    return this.collections.order(
      user.id,
      req.correlationId,
      dto.collection_ids,
    );
  }

  @Get(':id')
  @RequirePlatformRole(PlatformRole.PLATFORM_ADMIN)
  detail(@Param('id', uuid) id: string) {
    return this.collections.detail(id);
  }

  @Patch(':id')
  @RequirePlatformRole(PlatformRole.PLATFORM_ADMIN)
  @UseInterceptors(IdempotencyInterceptor)
  update(
    @Param('id', uuid) id: string,
    @Body() dto: UpdatePlatformCollectionDto,
    @CurrentUser() user: AuthenticatedUser,
    @Req() req: Request,
  ) {
    return this.collections.update(user.id, req.correlationId, id, dto);
  }

  @Put(':id/items')
  @RequirePlatformRole(PlatformRole.PLATFORM_ADMIN)
  @UseInterceptors(IdempotencyInterceptor)
  setItems(
    @Param('id', uuid) id: string,
    @Body() dto: SetCollectionItemsDto,
    @CurrentUser() user: AuthenticatedUser,
    @Req() req: Request,
  ) {
    return this.collections.setItems(
      user.id,
      req.correlationId,
      id,
      dto.canonical_product_ids,
    );
  }

  @Post(':id/publish')
  @HttpCode(200)
  @RequirePlatformRole(PlatformRole.PLATFORM_ADMIN)
  @UseInterceptors(IdempotencyInterceptor)
  publish(
    @Param('id', uuid) id: string,
    @CurrentUser() user: AuthenticatedUser,
    @Req() req: Request,
  ) {
    return this.collections.publish(user.id, req.correlationId, id);
  }

  @Post(':id/archive')
  @HttpCode(200)
  @RequirePlatformRole(PlatformRole.PLATFORM_ADMIN)
  @UseInterceptors(IdempotencyInterceptor)
  archive(
    @Param('id', uuid) id: string,
    @CurrentUser() user: AuthenticatedUser,
    @Req() req: Request,
  ) {
    return this.collections.archive(user.id, req.correlationId, id);
  }

  @Post(':id/reopen')
  @HttpCode(200)
  @RequirePlatformRole(PlatformRole.PLATFORM_ADMIN)
  @UseInterceptors(IdempotencyInterceptor)
  reopen(
    @Param('id', uuid) id: string,
    @CurrentUser() user: AuthenticatedUser,
    @Req() req: Request,
  ) {
    return this.collections.reopen(user.id, req.correlationId, id);
  }

  @Delete(':id')
  @HttpCode(204)
  @RequirePlatformRole(PlatformRole.PLATFORM_ADMIN)
  @UseInterceptors(IdempotencyInterceptor)
  async remove(
    @Param('id', uuid) id: string,
    @CurrentUser() user: AuthenticatedUser,
    @Req() req: Request,
  ) {
    await this.collections.remove(user.id, req.correlationId, id);
  }
}
