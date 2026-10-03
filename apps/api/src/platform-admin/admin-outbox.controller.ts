import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { PlatformRole } from '../../generated/prisma/client';
import { RequirePlatformRole } from '../auth/platform-role.decorator';
import { PlatformRoleGuard } from '../auth/platform-role.guard';
import { SessionAuthGuard } from '../auth/session-auth.guard';
import { PrismaService } from '../prisma/prisma.service';
import {
  decodeCursor,
  encodeCursor,
  isIsoDateString,
  isUuidLike,
  parseLimit,
} from './cursor.util';

/**
 * Sprint 19 (SRS-H1-08, SRS-P-12): read-only dead-letter visibility for
 * the Outbox relay - PLATFORM_ADMIN only. No requeue action in this
 * sprint (deliberately out of scope - see the S19 plan's own note); a
 * `DEAD_LETTER` row here either exhausted MAX_ATTEMPTS genuinely
 * failing, or (for the three event types whose recipient-snapshot bug
 * this sprint fixed) predates that fix entirely and was moved here by
 * this sprint's own migration, tagged `lastError =
 * 'LEGACY_MISSING_RECIPIENT_SNAPSHOT'`.
 */
@Controller('admin/outbox')
@UseGuards(SessionAuthGuard, PlatformRoleGuard)
export class AdminOutboxController {
  constructor(private readonly prisma: PrismaService) {}

  @Get('dead-letter')
  @RequirePlatformRole(PlatformRole.PLATFORM_ADMIN)
  async listDeadLetter(
    @Query('cursor') cursor?: string,
    @Query('limit') limitRaw?: string,
  ) {
    const limit = parseLimit(limitRaw);
    const cursorParts = decodeCursor(cursor, [isIsoDateString, isUuidLike]);

    const rows = await this.prisma.outboxEvent.findMany({
      where: {
        status: 'DEAD_LETTER',
        ...(cursorParts
          ? {
              OR: [
                { createdAt: { lt: new Date(cursorParts[0] as string) } },
                {
                  createdAt: new Date(cursorParts[0] as string),
                  id: { lt: cursorParts[1] as string },
                },
              ],
            }
          : {}),
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: limit + 1,
    });
    const hasMore = rows.length > limit;
    const page = rows.slice(0, limit);
    const last = page[page.length - 1];

    return {
      items: page.map((row) => ({
        id: row.id,
        event_type: row.eventType,
        attempt_count: row.attemptCount,
        last_error: row.lastError,
        created_at: row.createdAt.toISOString(),
        available_at: row.availableAt.toISOString(),
      })),
      next_cursor:
        hasMore && last
          ? encodeCursor([last.createdAt.toISOString(), last.id])
          : null,
    };
  }
}
