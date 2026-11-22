import { Prisma } from '../../generated/prisma/client';
import { OutboxEventService } from '../outbox/outbox-event.service';
import { PlatformAlertRecipientsService } from '../platform-alerts/platform-alert-recipients.service';

export const RETURN_ESCALATION_ALERT_EVENT = 'return.escalation_alert';

/** Why a return reached ESCALATED: 72h without a store decision, or the
 * customer disputing the store's rejection. */
export type ReturnEscalationReason = 'SLA_TIMEOUT' | 'CUSTOMER_DISPUTE';

/**
 * TB-14: tells the platform a return awaits its decision - one outbox
 * row per RETURN_ESCALATION subscriber who is still an active
 * administrator, else every active administrator (TB-12.2's resolver,
 * fallback logged by count). Call it in the transaction that moves the
 * return to ESCALATED, after the row's lock and status re-check: that
 * transition happens once per return, so the alert does too.
 * No vendor_id/branch_id: the alert is not a store workspace
 * notification. Never the customer's note or the store's reason.
 */
export async function enqueueReturnEscalationAlert(
  tx: Prisma.TransactionClient,
  outbox: OutboxEventService,
  recipients: PlatformAlertRecipientsService,
  returnId: string,
  reason: ReturnEscalationReason,
): Promise<void> {
  const { userIds } = await recipients.resolve(tx, 'RETURN_ESCALATION');
  for (const recipientId of userIds) {
    await outbox.enqueue(
      {
        eventType: RETURN_ESCALATION_ALERT_EVENT,
        audience: 'PLATFORM',
        payload: {
          return_id: returnId,
          reason,
          recipient_user_id: recipientId,
        },
      },
      tx,
    );
  }
}
