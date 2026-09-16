import { Injectable } from '@nestjs/common';
import { Prisma } from '../../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';

export interface RecordAuditEntryInput {
  actorId?: string | null;
  correlationId: string;
  action: string;
  entityType: string;
  entityId: string;
  beforeState?: unknown;
  afterState?: unknown;
}

/**
 * The single write path for every "must write an audit record"
 * requirement across Part 2 (E.11's state machines) and BR-019's
 * break-glass rule (Part 3, G.4). correlationId is required, not
 * optional - Part 4, H.1 requires every AuditLog row to carry it, so
 * this signature makes omitting it a compile error rather than a
 * silent gap. Every caller that needs its audit write to be atomic
 * with a business write passes `tx` - the same transaction client
 * Prisma hands to the callback of `$transaction`.
 */
@Injectable()
export class AuditLogService {
  constructor(private readonly prisma: PrismaService) {}

  async record(input: RecordAuditEntryInput, tx?: Prisma.TransactionClient) {
    const client = tx ?? this.prisma;
    return client.auditLog.create({
      data: {
        actorId: input.actorId ?? null,
        correlationId: input.correlationId,
        action: input.action,
        entityType: input.entityType,
        entityId: input.entityId,
        beforeState: (input.beforeState ?? undefined) as Prisma.InputJsonValue,
        afterState: (input.afterState ?? undefined) as Prisma.InputJsonValue,
      },
    });
  }
}
