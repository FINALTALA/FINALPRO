import {
  Body,
  Controller,
  HttpCode,
  Post,
  Req,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { Request } from 'express';
import { CurrentUser } from '../auth/current-user.decorator';
import {
  AuthenticatedUser,
  SessionAuthGuard,
} from '../auth/session-auth.guard';
import { IdempotencyInterceptor } from '../common/idempotency/idempotency.interceptor';
import { CreateMatchReportDto } from './dto/create-match-report.dto';
import { MatchReportsService } from './match-reports.service';

// Sprint 17b (FR-MATCH-005): any signed-in customer, never a candidate
// id from the client - see MatchReportsService's own comment for the
// full derive-don't-accept-id design. 20/hour/customer bounds spam
// across different offers; the service's own unique constraint already
// fully bounds repeat-spam on the same candidate.
@Controller('me/match-reports')
@UseGuards(SessionAuthGuard)
export class MatchReportsController {
  constructor(private readonly matchReports: MatchReportsService) {}

  @Post()
  @HttpCode(201)
  @Throttle({ default: { limit: 20, ttl: 3_600_000 } })
  @UseInterceptors(IdempotencyInterceptor)
  async create(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: CreateMatchReportDto,
    @Req() req: Request,
  ) {
    return this.matchReports.report(
      user.id,
      dto.offer_variant_id,
      dto.note,
      req.correlationId,
    );
  }
}
