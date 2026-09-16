import {
  Body,
  Controller,
  Get,
  Post,
  Req,
  UseInterceptors,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { Request } from 'express';
import { randomUUID } from 'crypto';
import { AuditLogService } from '../audit/audit-log.service';
import { IdempotencyInterceptor } from '../common/idempotency/idempotency.interceptor';
import { PrismaService } from '../prisma/prisma.service';

/**
 * The "sample endpoint [that] demonstrates every convention" Part 4's
 * H.1 asks Foundation to prove out: correlation IDs (global
 * middleware, visible in the response header on every route here),
 * the error-response format (trigger it by hitting an unknown route,
 * or stopping the DB and hitting /health), rate limiting (the demo
 * route below, plus the global default in app.module.ts), and the
 * Idempotency-Key convention (the /echo route).
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
      correlationId: req.correlationId,
      action: 'health.echo',
      entityType: 'HealthCheck',
      entityId: randomUUID(),
      afterState: body,
    });
    return { echoed: body, correlationId: req.correlationId };
  }

  /**
   * A deliberately strict limit (3/min instead of the global 100/min,
   * Part 4 H.1's example of a route-level @Throttle() override) purely
   * so the rate-limiting convention has something fast and deterministic
   * to test against without exhausting the real global limit in e2e
   * runs. Not a real business endpoint.
   */
  @Get('rate-limit-demo')
  @Throttle({ default: { limit: 3, ttl: 60_000 } })
  rateLimitDemo() {
    return { ok: true };
  }
}
