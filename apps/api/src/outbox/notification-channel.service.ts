import { Injectable, Logger } from '@nestjs/common';

/**
 * Sprint 19: the generalized version of SmsService's own OPEN-004
 * fallback contract - no real SMS/WhatsApp/email provider is approved
 * (OPEN-004 is still open), so this logs instead of sending, and
 * refuses loudly rather than silently claiming delivery if a future
 * `NOTIFICATION_PROVIDER` env var is ever set without a real
 * integration behind it.
 *
 * Deliberately NOT called from inside any OutboxRelayService
 * transaction - this is a best-effort side action after a Notification
 * row has already been durably committed, never a condition for
 * PUBLISHED/FAILED. Its own failure (or simply never getting called)
 * has no effect on Outbox delivery guarantees.
 */
@Injectable()
export class NotificationChannelService {
  private readonly logger = new Logger(NotificationChannelService.name);

  async notify(recipientUserId: string, summary: string): Promise<void> {
    if (process.env.NOTIFICATION_PROVIDER) {
      throw new Error(
        `NOTIFICATION_PROVIDER is set to "${process.env.NOTIFICATION_PROVIDER}" but no real provider integration exists yet (OPEN-004) - refusing to silently fall back and claim delivery`,
      );
    }
    this.logger.warn(
      `[NOTIFY-FALLBACK, OPEN-004] user ${recipientUserId}: ${summary}`,
    );
  }
}
