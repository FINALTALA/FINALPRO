import {
  BadRequestException,
  Controller,
  Get,
  Query,
  Res,
  UseGuards,
} from '@nestjs/common';
import type { Response } from 'express';
import { PlatformRole } from '../../generated/prisma/client';
import { RequirePlatformRole } from '../auth/platform-role.decorator';
import { PlatformRoleGuard } from '../auth/platform-role.guard';
import { SessionAuthGuard } from '../auth/session-auth.guard';
import { PrismaService } from '../prisma/prisma.service';
import {
  buildAuditLogWhere,
  buildSafeAuditSummary,
  sanitizeCsvFormulaField,
  toCsvRow,
} from './audit-log-export.util';
import {
  decodeCursor,
  encodeCursor,
  isIsoDateString,
  isUuidLike,
  parseLimit,
} from './cursor.util';

// Sprint 25 (FR-ADMIN-005): PLATFORM_ADMIN-only search/export over the
// `AuditLog` table every write path in this codebase already feeds -
// no new write path, read-only. Ordering for BOTH the list and the
// export is the exact same `occurredAt DESC, id DESC`, with a cursor
// that carries both parts (same two-column keyset pattern
// AdminOutboxController's own `createdAt`+`id` cursor already uses) -
// two rows sharing the same millisecond-precision `occurredAt` can
// never be skipped or repeated across pages this way.
const EXPORT_ROW_LIMIT = 50_000;

function parseOptionalDate(
  raw: string | undefined,
  field: string,
): Date | undefined {
  if (raw === undefined || raw === '') return undefined;
  const d = new Date(raw);
  if (Number.isNaN(d.getTime())) {
    throw new BadRequestException({
      code: 'INVALID_DATE',
      message: `${field} must be a valid date/time string`,
    });
  }
  return d;
}

@Controller('admin/audit-logs')
@UseGuards(SessionAuthGuard, PlatformRoleGuard)
export class AdminAuditLogsController {
  constructor(private readonly prisma: PrismaService) {}

  @Get()
  @RequirePlatformRole(PlatformRole.PLATFORM_ADMIN)
  async list(
    @Query('entity_type') entityType?: string,
    @Query('entity_id') entityId?: string,
    @Query('actor_id') actorId?: string,
    @Query('action') action?: string,
    @Query('correlation_id') correlationId?: string,
    @Query('from') fromRaw?: string,
    @Query('to') toRaw?: string,
    @Query('cursor') cursor?: string,
    @Query('limit') limitRaw?: string,
  ) {
    const limit = parseLimit(limitRaw, 100);
    const cursorParts = decodeCursor(cursor, [isIsoDateString, isUuidLike]);
    const where = buildAuditLogWhere({
      entityType,
      entityId,
      actorId,
      action,
      correlationId,
      from: parseOptionalDate(fromRaw, 'from'),
      to: parseOptionalDate(toRaw, 'to'),
    });

    const rows = await this.prisma.auditLog.findMany({
      where: {
        ...where,
        ...(cursorParts
          ? {
              OR: [
                { occurredAt: { lt: new Date(cursorParts[0] as string) } },
                {
                  occurredAt: new Date(cursorParts[0] as string),
                  id: { lt: cursorParts[1] as string },
                },
              ],
            }
          : {}),
      },
      orderBy: [{ occurredAt: 'desc' }, { id: 'desc' }],
      take: limit + 1,
    });
    const hasMore = rows.length > limit;
    const page = rows.slice(0, limit);
    const last = page[page.length - 1];

    return {
      items: page.map((row) => ({
        id: row.id,
        occurred_at: row.occurredAt.toISOString(),
        actor_id: row.actorId,
        correlation_id: row.correlationId,
        action: row.action,
        entity_type: row.entityType,
        entity_id: row.entityId,
        summary: buildSafeAuditSummary(
          row.action,
          row.beforeState,
          row.afterState,
        ),
      })),
      next_cursor:
        hasMore && last
          ? encodeCursor([last.occurredAt.toISOString(), last.id])
          : null,
    };
  }

  /**
   * Review-round fix: the safety gate is the SAME query's own result
   * size, never a separate `count()` taken before the fetch - a row
   * inserted between a `count()` and a later `findMany()` could
   * otherwise let the actual export exceed the limit despite `count()`
   * having passed. Fetching `EXPORT_ROW_LIMIT + 1` rows (in the exact
   * same deterministic order as the list endpoint) and rejecting
   * outright if that extra row exists means the one query IS the
   * limit check - there is no window for a race to slip through.
   */
  @Get('export')
  @RequirePlatformRole(PlatformRole.PLATFORM_ADMIN)
  async export(
    @Res() res: Response,
    @Query('entity_type') entityType?: string,
    @Query('entity_id') entityId?: string,
    @Query('actor_id') actorId?: string,
    @Query('action') action?: string,
    @Query('correlation_id') correlationId?: string,
    @Query('from') fromRaw?: string,
    @Query('to') toRaw?: string,
  ) {
    const where = buildAuditLogWhere({
      entityType,
      entityId,
      actorId,
      action,
      correlationId,
      from: parseOptionalDate(fromRaw, 'from'),
      to: parseOptionalDate(toRaw, 'to'),
    });

    const rows = await this.prisma.auditLog.findMany({
      where,
      orderBy: [{ occurredAt: 'desc' }, { id: 'desc' }],
      take: EXPORT_ROW_LIMIT + 1,
    });
    if (rows.length > EXPORT_ROW_LIMIT) {
      throw new BadRequestException({
        code: 'EXPORT_TOO_LARGE',
        message: `This export would exceed ${EXPORT_ROW_LIMIT} rows - narrow the filters (a tighter date range, for example) and try again`,
      });
    }

    const header = toCsvRow([
      'id',
      'occurred_at',
      'actor_id',
      'correlation_id',
      'action',
      'entity_type',
      'entity_id',
      'summary',
    ]);
    const lines = rows.map((row) =>
      toCsvRow(
        [
          row.id,
          row.occurredAt.toISOString(),
          row.actorId,
          row.correlationId,
          row.action,
          row.entityType,
          row.entityId,
          buildSafeAuditSummary(row.action, row.beforeState, row.afterState),
        ].map(sanitizeCsvFormulaField),
      ),
    );

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader(
      'Content-Disposition',
      'attachment; filename="audit-logs.csv"',
    );
    res.send([header, ...lines].join('\n'));
  }
}
