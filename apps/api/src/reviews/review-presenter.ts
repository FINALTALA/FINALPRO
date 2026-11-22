import {
  Prisma,
  ReviewAuthorDisplay,
  ReviewFit,
  ReviewTag,
} from '../../generated/prisma/client';
import { reviewMediaUrl } from './review-media.util';

/** PD-3 (decision 1): an author may edit their review this long after creating it. */
export const REVIEW_EDIT_WINDOW_DAYS = 30;
/** PD-3 (roadmap 4.2): images per review. */
export const MAX_REVIEW_MEDIA = 5;
export const MAX_REVIEW_TAGS = 3;
/**
 * PD-3: a fit verdict or an impression tag is summarised only once at
 * least this many visible reviews state it - the same "never a
 * misleading summary of one or two" rule as MIN_REVIEWS_TO_DISPLAY.
 */
export const MIN_SIGNALS_TO_SUMMARISE = 3;
/** PD-3 (decision 9): the item came back to the store. */
export const RETURNED_STATUSES = [
  'RECEIVED',
  'REFUND_PROCESSING',
  'REFUNDED',
] as const;

export const REVIEW_TAGS = Object.values(ReviewTag);
export const REVIEW_FITS = Object.values(ReviewFit);
export const REVIEW_AUTHOR_DISPLAYS = Object.values(ReviewAuthorDisplay);

const VERIFIED_CUSTOMER_FALLBACK = 'عميل موثّق';

/**
 * PD-3 (decision 4): never the full name, phone or address. ANONYMOUS
 * (the default) is "عميل موثّق"; FIRST_NAME_INITIAL is the profile
 * display name's first word plus the next word's first letter
 * ("سارة م."). A first word carrying a digit or an "@" (a phone number
 * or e-mail typed as a name) falls back to the anonymous label.
 */
export function authorLabel(
  mode: ReviewAuthorDisplay,
  displayName: string | null | undefined,
): string {
  if (mode !== 'FIRST_NAME_INITIAL' || !displayName) {
    return VERIFIED_CUSTOMER_FALLBACK;
  }
  const words = displayName.trim().split(/\s+/).filter(Boolean);
  const first = words[0];
  if (!first || /[\d@+]/.test(first)) return VERIFIED_CUSTOMER_FALLBACK;
  const initial = words[1] ? [...words[1]][0] : null;
  const shortFirst = [...first].slice(0, 20).join('');
  return initial && !/[\d@+]/.test(initial)
    ? `${shortFirst} ${initial}.`
    : shortFirst;
}

export function editableUntil(createdAt: Date): Date {
  return new Date(
    createdAt.getTime() + REVIEW_EDIT_WINDOW_DAYS * 24 * 60 * 60 * 1000,
  );
}

/** Everything a public review card needs - and nothing else. */
export const PUBLIC_REVIEW_SELECT = {
  id: true,
  customerId: true,
  targetType: true,
  canonicalProductId: true,
  vendorId: true,
  rating: true,
  body: true,
  moderationStatus: true,
  createdAt: true,
  editedAt: true,
  purchasedTitle: true,
  purchasedColorCode: true,
  purchasedColorLabel: true,
  purchasedSizeCode: true,
  purchasedSizeLabel: true,
  fitFeedback: true,
  tags: true,
  authorDisplay: true,
  helpfulCount: true,
  customer: { select: { displayName: true } },
  media: {
    where: { status: 'VISIBLE' },
    orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
    select: { id: true, altText: true, width: true, height: true },
  },
  sourceBranchOrderItem: {
    select: {
      vendorId: true,
      returns: {
        where: { status: { in: [...RETURNED_STATUSES] } },
        select: { id: true },
        take: 1,
      },
    },
  },
} satisfies Prisma.ReviewSelect;

export type PublicReviewRow = Prisma.ReviewGetPayload<{
  select: typeof PUBLIC_REVIEW_SELECT;
}>;

export interface ReviewViewer {
  customerId: string | null;
  /** Vendors the viewer is an active member of (they may not vote there). */
  memberVendorIds: Set<string>;
  votedReviewIds: Set<string>;
}

export interface SellerInfo {
  slug: string;
  name: string;
}

/**
 * The public review card. Keeps every Sprint 23 field (target_type,
 * canonical_product_id, vendor_id, moderation_status, author,
 * created_at) for existing clients and adds the PD-3 ones. Never
 * includes the customer id, phone, address or quantities.
 */
export function publicReviewDto(
  r: PublicReviewRow,
  sellers: Map<string, SellerInfo>,
  viewer: ReviewViewer | null,
) {
  const sellerVendorId = r.sourceBranchOrderItem.vendorId;
  const isAuthor = viewer?.customerId === r.customerId;
  const purchased =
    r.purchasedTitle || r.purchasedColorLabel || r.purchasedSizeLabel
      ? {
          title: r.purchasedTitle,
          color_code: r.purchasedColorCode,
          color_label: r.purchasedColorLabel,
          size_code: r.purchasedSizeCode,
          size_label: r.purchasedSizeLabel,
        }
      : null;
  return {
    id: r.id,
    target_type: r.targetType,
    canonical_product_id: r.canonicalProductId,
    vendor_id: r.vendorId,
    rating: r.rating,
    body: r.body,
    moderation_status: r.moderationStatus,
    author: authorLabel(r.authorDisplay, r.customer.displayName),
    verified_purchase: true,
    purchased,
    store: sellers.get(sellerVendorId) ?? null,
    returned: r.sourceBranchOrderItem.returns.length > 0,
    fit: r.fitFeedback,
    tags: r.tags,
    media: r.media.map((m) => ({
      id: m.id,
      url: reviewMediaUrl(m.id),
      alt_text: m.altText,
      width: m.width,
      height: m.height,
    })),
    helpful_count: r.helpfulCount,
    edited: r.editedAt !== null,
    created_at: r.createdAt,
    ...(viewer
      ? {
          viewer: {
            is_author: isAuthor,
            voted_helpful: viewer.votedReviewIds.has(r.id),
            can_vote:
              viewer.customerId !== null &&
              !isAuthor &&
              !viewer.memberVendorIds.has(sellerVendorId),
            can_report: viewer.customerId !== null && !isAuthor,
            can_edit:
              isAuthor &&
              r.moderationStatus === 'VISIBLE' &&
              editableUntil(r.createdAt) > new Date(),
          },
        }
      : {}),
  };
}
