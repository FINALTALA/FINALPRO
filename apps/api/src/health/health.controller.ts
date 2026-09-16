import {
  Body,
  Controller,
  Get,
  Post,
  Req,
  UseInterceptors,
} from '@nestjs/common';
import { Request } from 'express';
import { AuditLogService } from '../audit/audit-log.service';
import { IdempotencyInterceptor } from '../common/idempotency/idempotency.interceptor';
import { PrismaService } from '../prisma/prisma.service';

/**
 * The "sample endpoint [that] demonstrates every convention" Part 4's
 * H.1 asks Foundation to prove out: correlation IDs (global
 * middleware, visible in the response header on both routes below),
 * the error-response format (trigger it by stopping the DB and
 * hitting /health), rate limiting (ThrottlerModule, applied globally
 * in app.module.ts), and the Idempotency-Key convention (the /echo
 * route below).
 */
@Controller('health')
export class HealthController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auditLog: AuditLogService,
  ) {}

  @Get()
  async check() {
    await this.prisma.$queryRaw`SELECT 1`;
    return { status: 'ok', timestamp: new Date().toISOString() };
  }

  @Post('echo')
  @UseInterceptors(IdempotencyInterceptor)
  async echo(@Body() body: Record<string, unknown>, @Req() req: Request) {
    await this.auditLog.record({
      action: 'health.echo',
      entityType: 'HealthCheck',
      entityId: req.correlationId,
      afterState: body,
    });
    return { echoed: body, correlationId: req.correlationId };
  }
}
