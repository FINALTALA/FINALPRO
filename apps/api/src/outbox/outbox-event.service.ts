import { Injectable } from '@nestjs/common';
import { NotificationAudience, Prisma } from '../../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';

export interface EnqueueOutboxEventInput {
  eventType: string;
  /** TB-26: whom the notification(s) this event produces are for - the
   * shopping bell (CUSTOMER), the store workspace (STORE) or the platform
   * workspace (PLATFORM). Required at every call site: the relay never
   * derives it from the event or notification type. Stored in the payload
   * as `audience`. */
  audience: NotificationAudience;
  payload: Record<string, unknown>;
}

/**
 * The transactional-outbox write path (ADR-006, Part 3 G.3; Part 6 M.4).
 * `enqueue` must always be called with the same `tx` transaction client
 * used for the business write it accompanies (e.g. checkout's
 * CustomerOrder/VendorSuborder creation) - that is what makes the event
 * genuinely atomic with the write, unlike a direct Redis/BullMQ enqueue,
 * which cannot participate in a Postgres transaction.
 *
 * The relay worker that polls Pending rows and publishes them to BullMQ
 * is separate infrastructure, built alongside the first feature that
 * actually needs it (Sprint 5-6, Part 8) - this service only covers the
 * durable-write half of the pattern, which is what Foundation needs to
 * establish now so every later epic writes to the outbox the same way.
 */
@Injectable()
export class OutboxEventService {
  constructor(private readonly prisma: PrismaService) {}

  async enqueue(input: EnqueueOutboxEventInput, tx?: Prisma.TransactionClient) {
    const client = tx ?? this.prisma;
    return client.outboxEvent.create({
      data: {
        eventType: input.eventType,
        payload: {
          ...input.payload,
          audience: input.audience,
        } as Prisma.InputJsonValue,
      },
    });
  }
}
