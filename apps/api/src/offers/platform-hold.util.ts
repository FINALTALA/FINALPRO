import { Prisma } from '../../generated/prisma/client';

/**
 * VIA phase 2C - Platform Hold, the ONE rule every public and purchase
 * path uses: an offer with an OPEN platform hold (OfferPlatformHold with
 * releasedAt null) is out of the marketplace, whatever its own status.
 *
 * Public reads add OFFER_NOT_HELD next to their existing
 * `status: 'ACTIVE'`; purchase eligibility (add-to-cart, quote, reserve,
 * confirm) checks it after its vendor-row locks, so a hold and a
 * confirmation are serialized (see offer-moderation.service.ts). Owner and
 * platform-admin reads never apply it: the owner still sees and edits the
 * held offer, and the hold never changes `status`.
 */
export const OFFER_NOT_HELD = {
  platformHolds: { none: { releasedAt: null } },
} satisfies Prisma.VendorOfferWhereInput;

/** The public listing condition: published by the owner AND not held. */
export const PUBLIC_OFFER = {
  status: 'ACTIVE',
  ...OFFER_NOT_HELD,
} satisfies Prisma.VendorOfferWhereInput;

/** Select an offer's open hold (0 or 1 row) alongside it. */
export const OPEN_HOLD_SELECT = {
  where: { releasedAt: null },
  select: { id: true, action: true },
  take: 1,
} satisfies Prisma.VendorOffer$platformHoldsArgs;

/** Of the given offers, those under an open platform hold. */
export async function heldOfferIds(
  db: Prisma.TransactionClient,
  offerIds: string[],
): Promise<Set<string>> {
  const ids = [...new Set(offerIds)];
  if (ids.length === 0) return new Set();
  const rows = await db.offerPlatformHold.findMany({
    where: { vendorOfferId: { in: ids }, releasedAt: null },
    select: { vendorOfferId: true },
  });
  return new Set(rows.map((r) => r.vendorOfferId));
}
