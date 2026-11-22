import { ConflictException } from '@nestjs/common';
import { Prisma } from '../../generated/prisma/client';

/**
 * «مجموعات المتجر» (2026-11-18): the store's own manual collections, stored
 * as store sections (StoreSection / StoreSectionOffer). A product can be in
 * several collections; its platform category never changes through them.
 *
 * Shared by the owner's collections API, the product's own «المجموعات»
 * field and the wizard's publish - every write that adds products goes
 * through appendToCollection(), so "a product added later goes last" and the
 * per-collection limit hold everywhere, under one per-collection lock.
 */
export const MAX_STORE_COLLECTIONS = 20;
export const MAX_COLLECTION_PRODUCTS = 500;

type Tx = Prisma.TransactionClient;

export async function lockCollection(tx: Tx, sectionId: string) {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('finalpro:store_section_offers:' || ${sectionId}))`;
}

/**
 * Adds the given products (in that order) at the END of the collection;
 * products already in it keep their place. Refuses the whole call (nothing
 * added) when the collection would pass MAX_COLLECTION_PRODUCTS. The caller
 * has already checked that the collection and the products are this store's.
 */
export async function appendToCollection(
  tx: Tx,
  vendorId: string,
  sectionId: string,
  offerIds: string[],
): Promise<{ added: string[]; already: string[] }> {
  await lockCollection(tx, sectionId);
  const existing = await tx.storeSectionOffer.findMany({
    where: { sectionId },
    select: { offerId: true, sortOrder: true },
  });
  const inIt = new Set(existing.map((e) => e.offerId));
  const unique = [...new Set(offerIds)];
  const toAdd = unique.filter((id) => !inIt.has(id));
  const already = unique.filter((id) => inIt.has(id));
  if (existing.length + toAdd.length > MAX_COLLECTION_PRODUCTS) {
    throw new ConflictException({
      code: 'STORE_COLLECTION_FULL',
      message: `A collection holds at most ${MAX_COLLECTION_PRODUCTS} products`,
      details: {
        limit: MAX_COLLECTION_PRODUCTS,
        current: existing.length,
        adding: toAdd.length,
      },
    });
  }
  let next = existing.reduce((m, e) => Math.max(m, e.sortOrder + 1), 0);
  if (toAdd.length > 0) {
    await tx.storeSectionOffer.createMany({
      data: toAdd.map((offerId) => ({
        vendorId,
        sectionId,
        offerId,
        sortOrder: next++,
      })),
    });
  }
  return { added: toAdd, already };
}

/** Rewrites the collection's order to exactly `orderedOfferIds` (0..n-1). */
export async function writeCollectionOrder(
  tx: Tx,
  sectionId: string,
  orderedOfferIds: string[],
) {
  if (orderedOfferIds.length === 0) return;
  await tx.$executeRaw`
    UPDATE store_section_offers o
    SET "sortOrder" = (v.pos - 1)::int
    FROM unnest(${orderedOfferIds}::text[]) WITH ORDINALITY AS v(offer_id, pos)
    WHERE o."sectionId" = ${sectionId} AND o."offerId" = v.offer_id`;
}

/**
 * The products a shopper can see in a collection: published (ACTIVE) and
 * with live stock in a sellable branch - the same availability the store
 * page and checkout use. A draft, unpublished or sold-out product stays
 * linked, it is just not shown.
 */
export function shopperVisible(offer: { status: string }, available: number) {
  return offer.status === 'ACTIVE' && available > 0;
}
