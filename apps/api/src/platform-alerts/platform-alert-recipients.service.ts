import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { PlatformAlertCategory, Prisma } from '../../generated/prisma/client';
import { AuditLogService } from '../audit/audit-log.service';
import { PrismaService } from '../prisma/prisma.service';

export const ALERT_RECIPIENT_ADDED_ACTION = 'platform_alert_recipient.added';
export const ALERT_RECIPIENT_REMOVED_ACTION =
  'platform_alert_recipient.removed';

/** Who an alert of one category goes to, and why. */
export interface ResolvedAlertRecipients {
  userIds: string[];
  /** SUBSCRIBED: the category's active subscribers. FALLBACK: nobody
   * active is subscribed, so every active administrator. */
  mode: 'SUBSCRIBED' | 'FALLBACK';
}

/** An administrator who may receive platform alerts right now. */
const ACTIVE_ADMIN: Prisma.UserWhereInput = {
  platformRole: 'PLATFORM_ADMIN',
  deactivatedAt: null,
};

/**
 * TB-12.2: who receives each category of platform alert. A subscription
 * is explicit, per (administrator, category); at send time it only
 * counts while its holder is still PLATFORM_ADMIN and not deactivated -
 * revoking the role or deactivating the account takes them out at
 * once, with no clean-up needed. When no active administrator is
 * subscribed, the alert goes to every active administrator instead and
 * the fallback is logged (count only), so an alert is never lost and
 * never silently over-broadcast.
 */
@Injectable()
export class PlatformAlertRecipientsService {
  private readonly logger = new Logger(PlatformAlertRecipientsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly auditLog: AuditLogService,
  ) {}

  /** The recipients of one alert, read in the sender's transaction. */
  async resolve(
    tx: Prisma.TransactionClient,
    category: PlatformAlertCategory,
  ): Promise<ResolvedAlertRecipients> {
    const subscribed = await tx.platformAlertRecipient.findMany({
      where: { category, user: ACTIVE_ADMIN },
      select: { userId: true },
      orderBy: { userId: 'asc' },
    });
    if (subscribed.length > 0) {
      return { userIds: subscribed.map((r) => r.userId), mode: 'SUBSCRIBED' };
    }
    const admins = await tx.user.findMany({
      where: ACTIVE_ADMIN,
      select: { id: true },
      orderBy: { id: 'asc' },
    });
    this.logger.warn(
      `No active administrator is subscribed to ${category} platform alerts - ` +
        `sending to all ${admins.length} active platform administrators instead`,
    );
    return { userIds: admins.map((a) => a.id), mode: 'FALLBACK' };
  }

  /**
   * Subscribes an administrator to a category. Idempotent by nature:
   * subscribing someone already subscribed changes nothing and writes
   * no audit row. The target is locked and re-checked in the same
   * transaction, so a concurrent role revocation or deactivation can
   * never leave a subscription for a non-administrator behind it - and
   * two concurrent adds of the same pair insert (and audit) once.
   * The audit row names the recipient by internal id only - never a
   * phone or any other personal data.
   */
  async add(
    tx: Prisma.TransactionClient,
    category: PlatformAlertCategory,
    userId: string,
    actorId: string,
    correlationId: string,
  ): Promise<{ added: boolean }> {
    await this.lockEligibleAdmin(tx, userId);
    const inserted = await tx.$queryRaw<{ id: string }[]>`
      INSERT INTO platform_alert_recipients (id, "userId", category, "addedByUserId")
      VALUES (gen_random_uuid()::text, ${userId}, ${category}::"PlatformAlertCategory", ${actorId})
      ON CONFLICT ("userId", category) DO NOTHING
      RETURNING id`;
    if (inserted.length === 0) return { added: false };
    await this.auditLog.record(
      {
        actorId,
        correlationId,
        action: ALERT_RECIPIENT_ADDED_ACTION,
        entityType: 'User',
        entityId: userId,
        afterState: { category, recipient_user_id: userId },
      },
      tx,
    );
    return { added: true };
  }

  /** Unsubscribes. Idempotent: removing a subscription that does not
   * exist changes nothing and writes no audit row. Allowed for any
   * subscriber, including one who is no longer an administrator. */
  async remove(
    tx: Prisma.TransactionClient,
    category: PlatformAlertCategory,
    userId: string,
    actorId: string,
    correlationId: string,
  ): Promise<{ removed: boolean }> {
    const deleted = await tx.$queryRaw<{ id: string }[]>`
      DELETE FROM platform_alert_recipients
      WHERE "userId" = ${userId} AND category = ${category}::"PlatformAlertCategory"
      RETURNING id`;
    if (deleted.length === 0) return { removed: false };
    await this.auditLog.record(
      {
        actorId,
        correlationId,
        action: ALERT_RECIPIENT_REMOVED_ACTION,
        entityType: 'User',
        entityId: userId,
        beforeState: { category, recipient_user_id: userId },
      },
      tx,
    );
    return { removed: true };
  }

  /** The same 404 for "no such user", "not an administrator" and
   * "deactivated" - the endpoint never confirms which accounts exist. */
  private async lockEligibleAdmin(
    tx: Prisma.TransactionClient,
    userId: string,
  ): Promise<void> {
    const rows = await tx.$queryRaw<
      { platformRole: string | null; deactivatedAt: Date | null }[]
    >`SELECT "platformRole", "deactivatedAt" FROM users WHERE id = ${userId} FOR SHARE`;
    const user = rows[0];
    if (
      !user ||
      user.platformRole !== 'PLATFORM_ADMIN' ||
      user.deactivatedAt !== null
    ) {
      throw new NotFoundException({
        code: 'ALERT_RECIPIENT_NOT_ELIGIBLE',
        message: 'No active platform administrator with this id',
      });
    }
  }

  /** What an administrator sees when managing recipients: the active
   * administrators (id and the last three digits of the phone - enough
   * to tell colleagues apart, nothing more) and, per category, its
   * active subscribers and whether alerts would fall back to everyone. */
  async overview() {
    const admins = await this.prisma.user.findMany({
      where: ACTIVE_ADMIN,
      select: { id: true, phone: true },
      orderBy: { createdAt: 'asc' },
    });
    const subs = await this.prisma.platformAlertRecipient.findMany({
      where: { user: ACTIVE_ADMIN },
      select: { userId: true, category: true },
    });
    return {
      administrators: admins.map((a) => ({
        user_id: a.id,
        phone_hint: `•••${a.phone.slice(-3)}`,
      })),
      categories: Object.values(PlatformAlertCategory).map((category) => {
        const ids = subs
          .filter((s) => s.category === category)
          .map((s) => s.userId);
        return {
          category,
          recipient_user_ids: ids,
          delivery:
            ids.length > 0 ? 'SUBSCRIBED' : 'FALLBACK_ALL_ACTIVE_ADMINS',
        };
      }),
    };
  }
}
