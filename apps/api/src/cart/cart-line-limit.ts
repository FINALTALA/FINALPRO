import { UnprocessableEntityException } from '@nestjs/common';
import { Prisma } from '../../generated/prisma/client';

/**
 * TB-1: the most of one variant a customer may have in their cart (and
 * so buy in one checkout). A public purchase rule, not a stock figure -
 * it is what keeps the cart's quantity validation (PDR-017's one
 * exception) from ever revealing a branch's real stock above it.
 */
export const CART_LINE_LIMIT = 10;

export function cartLineLimitExceeded(): UnprocessableEntityException {
  return new UnprocessableEntityException({
    code: 'CART_LINE_LIMIT_EXCEEDED',
    message: `At most ${CART_LINE_LIMIT} of one item per order`,
    details: [{ limit: CART_LINE_LIMIT }],
  });
}

/**
 * Serialises every cart write for one (customer, variant) for the rest
 * of the transaction, so two concurrent add/update calls can never both
 * pass the limit check on the same starting quantity.
 */
export async function lockCartVariant(
  tx: Prisma.TransactionClient,
  customerId: string,
  offerVariantId: string,
): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`cart-line:${customerId}:${offerVariantId}`}))`;
}

/**
 * The customer's total of this variant across the cart, with
 * `exceptItemId`'s own quantity replaced by `lineQuantity` (or added as
 * a new line) - must be called under lockCartVariant().
 */
export async function assertWithinCartLineLimit(
  tx: Prisma.TransactionClient,
  customerId: string,
  offerVariantId: string,
  lineQuantity: number,
  exceptItemId: string | null,
): Promise<void> {
  const others = await tx.cartItem.aggregate({
    where: {
      customerId,
      offerVariantId,
      ...(exceptItemId ? { id: { not: exceptItemId } } : {}),
    },
    _sum: { quantity: true },
  });
  if ((others._sum.quantity ?? 0) + lineQuantity > CART_LINE_LIMIT) {
    throw cartLineLimitExceeded();
  }
}

/** Defence in depth for quote/reserve: no line over the limit gets through. */
export function assertCartLinesWithinLimit(
  items: { offerVariantId: string; quantity: number }[],
): void {
  const totals = new Map<string, number>();
  for (const i of items) {
    totals.set(
      i.offerVariantId,
      (totals.get(i.offerVariantId) ?? 0) + i.quantity,
    );
  }
  for (const total of totals.values()) {
    if (total > CART_LINE_LIMIT) throw cartLineLimitExceeded();
  }
}
