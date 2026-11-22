import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Min,
  ValidateNested,
} from 'class-validator';
import { Request } from 'express';
import { CurrentUser } from '../auth/current-user.decorator';
import {
  AuthenticatedUser,
  SessionAuthGuard,
} from '../auth/session-auth.guard';
import { VendorMembershipGuard } from '../auth/vendor-membership.guard';
import { RequireVendorRole } from '../auth/vendor-role.decorator';
import { BlockWhenSuspended } from '../auth/vendor-suspended.guard';
import { BulkPublishService, MAX_BULK_PUBLISH } from './bulk-publish.service';

export class BulkPreflightDto {
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(MAX_BULK_PUBLISH)
  @IsString({ each: true })
  draft_ids!: string[];
}

export class BulkPublishItemDto {
  @IsString()
  draft_id!: string;

  @IsInt()
  @Min(1)
  expected_revision!: number;
}

export class BulkPublishStartDto {
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(MAX_BULK_PUBLISH)
  @ValidateNested({ each: true })
  @Type(() => BulkPublishItemDto)
  items!: BulkPublishItemDto[];

  @IsOptional()
  @IsUUID()
  import_batch_id?: string;
}

/**
 * Bulk publishing of drafts (2026-11-18): a read-only preflight with the
 * publish gate, then a run over what the owner confirmed - carried on by
 * the server, one run at a time per store. Owner only, like publishing a
 * draft; starting is blocked for a suspended store.
 */
@Controller('vendors/:vendorId/bulk-publish')
@UseGuards(SessionAuthGuard, VendorMembershipGuard)
@RequireVendorRole('OWNER')
export class BulkPublishController {
  constructor(private readonly service: BulkPublishService) {}

  /** Read-only (nothing is written): which chosen drafts are ready, and why the others are not. */
  @Post('preflight')
  @HttpCode(200)
  preflight(
    @Param('vendorId') vendorId: string,
    @Body() dto: BulkPreflightDto,
  ) {
    return this.service.preflight(vendorId, dto.draft_ids);
  }

  @Post()
  @HttpCode(201)
  @BlockWhenSuspended()
  start(
    @Param('vendorId') vendorId: string,
    @Body() dto: BulkPublishStartDto,
    @CurrentUser() user: AuthenticatedUser,
    @Req() req: Request,
  ) {
    return this.service.start(vendorId, user.id, req.correlationId, dto);
  }

  /** The running run - of one import batch when `import_batch_id` is given. */
  @Get('current')
  current(
    @Param('vendorId') vendorId: string,
    @Query('import_batch_id') importBatchId?: string,
  ) {
    return this.service.current(vendorId, importBatchId || undefined);
  }

  @Get(':runId')
  get(@Param('vendorId') vendorId: string, @Param('runId') runId: string) {
    return this.service.get(vendorId, runId);
  }
}
