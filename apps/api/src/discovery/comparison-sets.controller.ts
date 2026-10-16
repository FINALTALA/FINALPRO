import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Post,
  UseGuards,
} from '@nestjs/common';
import { CurrentUser } from '../auth/current-user.decorator';
import {
  AuthenticatedUser,
  SessionAuthGuard,
} from '../auth/session-auth.guard';
import { AddComparisonSetItemDto } from './dto/add-comparison-set-item.dto';
import { CreateComparisonSetDto } from './dto/create-comparison-set.dto';
import { ComparisonSetsService } from './comparison-sets.service';

// Sprint 24 (FR-COMP-001/002/007): owner CRUD, session-guarded, every
// route scoped to the session user - the internal set id is never
// accepted on any PUBLIC route (see ComparisonSetsSharedController
// below), only here under a signed-in customer's own namespace.
@Controller('customers/me/comparison-sets')
@UseGuards(SessionAuthGuard)
export class ComparisonSetsController {
  constructor(private readonly sets: ComparisonSetsService) {}

  @Post()
  async create(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: CreateComparisonSetDto,
  ) {
    return this.sets.create(user.id, dto.canonical_product_ids);
  }

  @Get()
  async list(@CurrentUser() user: AuthenticatedUser) {
    return this.sets.list(user.id);
  }

  @Get(':id')
  async getOwn(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
  ) {
    return this.sets.getOwn(user.id, id);
  }

  @Post(':id/items')
  async addItem(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Body() dto: AddComparisonSetItemDto,
  ) {
    return this.sets.addItem(user.id, id, dto.canonical_product_id);
  }

  @Delete(':id/items/:canonicalProductId')
  async removeItem(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Param('canonicalProductId') canonicalProductId: string,
  ) {
    return this.sets.removeItem(user.id, id, canonicalProductId);
  }

  @Delete(':id')
  async delete(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
  ) {
    await this.sets.delete(user.id, id);
    return { deleted: true };
  }
}

// Sprint 24 (FR-COMP-007): the public share link - deliberately a
// SEPARATE controller/route tree from the owner CRUD above, never
// nested under it, so there is no shared path prefix a client could
// confuse the two under. Accepts ONLY the opaque shareSlug, never the
// internal id.
@Controller('comparison-sets/shared')
export class ComparisonSetsSharedController {
  constructor(private readonly sets: ComparisonSetsService) {}

  @Get(':shareSlug')
  async getShared(@Param('shareSlug') shareSlug: string) {
    return this.sets.getShared(shareSlug);
  }
}
