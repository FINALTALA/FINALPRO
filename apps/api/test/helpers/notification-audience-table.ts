/**
 * TB-26: the audience every NotificationType has by its senders in the
 * code - used ONLY to check the migration's backfill and that every type
 * is classified (tb26-audience-migration.e2e-spec.ts) and that each live
 * sender writes the audience it should (tb26-workspace-scoping). The
 * running app never reads this: every sender sets the audience
 * explicitly. Two views: the snapshot TB-26's migration classified, and
 * the current schema (that snapshot + the types added later, each by its
 * own migration).
 *
 * ORDER_CANCELLED is the one type sent to both sides (to the customer
 * when the store / platform / sweep cancels; to the branch team when the
 * customer cancels), so it has no single entry here.
 */
export const ORDER_CANCELLED_IS_DUAL = 'ORDER_CANCELLED';

type Audience = 'CUSTOMER' | 'STORE' | 'PLATFORM';

/**
 * The types TB-26's migration (20261115120000_tb26_notification_audience)
 * classified - its backfill CASE, exactly as they were then. A type added
 * later is NOT here: it never existed for that backfill.
 */
export const NOTIFICATION_AUDIENCE_AT_TB26: Record<string, Audience> = {
  DELIVERY_CONFIRM_REQUESTED: 'CUSTOMER',
  ORDER_AUTO_CONFIRMED: 'CUSTOMER',
  DELIVERY_CONFIRM_REMINDER: 'CUSTOMER',
  DELIVERY_FAILED: 'CUSTOMER',
  REFUND_APPROVED: 'CUSTOMER',
  REFUND_AUTOMATIC: 'CUSTOMER',
  SLOT_MISSED: 'CUSTOMER',
  REVIEW_INVITATION: 'CUSTOMER',
  REVIEW_HIDDEN: 'CUSTOMER',
  FOLLOWED_STORE_NEW_PRODUCT: 'CUSTOMER',
  FOLLOWED_STORE_DISCOUNT: 'CUSTOMER',
  FAVORITE_PRICE_DROP: 'CUSTOMER',
  FAVORITE_BACK_IN_STOCK: 'CUSTOMER',
  FAVORITE_NEW_OFFER: 'CUSTOMER',
  RETURN_APPROVED: 'CUSTOMER',
  RETURN_REJECTED: 'CUSTOMER',
  RETURN_ADMIN_REJECTED: 'CUSTOMER',
  RETURN_ESCALATED: 'CUSTOMER',
  RETURN_REFUNDED: 'CUSTOMER',
  RETURN_EXCHANGED: 'CUSTOMER',
  RETURN_CODE_EXPIRED: 'CUSTOMER',
  STOCK_ADJUSTMENT: 'STORE',
  NOT_RECEIVED_REPORTED: 'STORE',
  VENDOR_SUSPENDED: 'STORE',
  VENDOR_REACTIVATED: 'STORE',
  NEW_ORDER_FOR_EMPLOYEE: 'STORE',
  LOW_STOCK_AFTER_RESERVE: 'STORE',
  ORDER_RESCHEDULED: 'STORE',
  REFUND_REQUESTED: 'STORE',
  PREP_REMINDER: 'STORE',
  RETURN_REQUESTED: 'STORE',
  RETURN_VENDOR_REMINDER: 'STORE',
  RETURN_PLATFORM_APPROVED: 'STORE',
  RETURN_PLATFORM_REJECTED: 'STORE',
  RETURN_CANCELLED_BY_CUSTOMER: 'STORE',
  ORDER_INTEGRITY_ALERT: 'PLATFORM',
  RETURN_ESCALATION_ALERT: 'PLATFORM',
};

/**
 * Types added AFTER TB-26, each by its own later migration (ALTER TYPE
 * "NotificationType" ADD VALUE), with the audience its sender writes.
 */
export const NOTIFICATION_TYPES_AFTER_TB26: Record<
  string,
  { audience: Audience; migration: string }
> = {
  // bulk publishing: one summary per run to the store's followers
  FOLLOWED_STORE_NEW_PRODUCTS: {
    audience: 'CUSTOMER',
    migration: '20261123120000_bulk_publish',
  },
  // «نبّهيني عند التوفر»: one exact colour x size back in stock, to the shopper who asked
  VARIANT_BACK_IN_STOCK: {
    audience: 'CUSTOMER',
    migration: '20261124120000_variant_availability_subscriptions',
  },
};

/** Every type of the CURRENT schema: TB-26's, plus the ones added after it. */
export const NOTIFICATION_AUDIENCE_BY_TYPE: Record<string, Audience> = {
  ...NOTIFICATION_AUDIENCE_AT_TB26,
  ...Object.fromEntries(
    Object.entries(NOTIFICATION_TYPES_AFTER_TB26).map(([type, x]) => [
      type,
      x.audience,
    ]),
  ),
};
