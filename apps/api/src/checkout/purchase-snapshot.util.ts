import { Prisma } from '../../generated/prisma/client';

export interface PurchaseSnapshot {
  titleArSnapshot: string;
  titleEnSnapshot: string;
  colorCodeSnapshot: string | null;
  colorLabelSnapshot: string | null;
  /** Product colours: the colour as bought - id, names, HEX, fabric swatch. */
  offerColorIdSnapshot: string | null;
  colorNameArSnapshot: string | null;
  colorNameEnSnapshot: string | null;
  colorHexSnapshot: string | null;
  colorSwatchUrlSnapshot: string | null;
  sizeCodeSnapshot: string | null;
  sizeLabelSnapshot: string | null;
}

/**
 * PD-3: what each purchased variant *is* at the moment the order is
 * created - the offer's title and the variant's colour/size with their
 * taxonomy labels - read inside the confirming transaction and written
 * onto BranchOrderItem. Reviews copy these later, so a rename, a
 * re-classification or an archive never rewrites what was bought.
 * An unclassified variant (no colorCode/sizeCode) snapshots null
 * colour/size - never a guess from free-text attributes.
 */
export async function purchaseSnapshots(
  tx: Prisma.TransactionClient,
  offerVariantIds: string[],
): Promise<Map<string, PurchaseSnapshot>> {
  const ids = [...new Set(offerVariantIds)];
  const variants = await tx.offerVariant.findMany({
    where: { id: { in: ids } },
    select: {
      id: true,
      colorCode: true,
      sizeCode: true,
      offerColor: {
        select: {
          id: true,
          nameAr: true,
          nameEn: true,
          hex: true,
          swatchUrl: true,
        },
      },
      vendorOffer: { select: { titleAr: true, titleEn: true } },
    },
  });
  const colorCodes = [
    ...new Set(variants.map((v) => v.colorCode).filter((c) => c !== null)),
  ];
  const sizeCodes = [
    ...new Set(variants.map((v) => v.sizeCode).filter((c) => c !== null)),
  ];
  const [colors, sizes] = await Promise.all([
    colorCodes.length
      ? tx.taxonomyColor.findMany({
          where: { code: { in: colorCodes } },
          select: { code: true, nameAr: true },
        })
      : ([] as { code: string; nameAr: string }[]),
    sizeCodes.length
      ? tx.taxonomySize.findMany({
          where: { code: { in: sizeCodes } },
          select: { code: true, label: true },
        })
      : ([] as { code: string; label: string }[]),
  ]);
  const colorLabel = new Map(colors.map((c) => [c.code, c.nameAr]));
  const sizeLabel = new Map(sizes.map((s) => [s.code, s.label]));
  return new Map(
    variants.map((v) => [
      v.id,
      {
        titleArSnapshot: v.vendorOffer.titleAr,
        titleEnSnapshot: v.vendorOffer.titleEn,
        colorCodeSnapshot: v.colorCode,
        // the name the shopper saw: the product colour's (older versions
        // without one: the family's, as before)
        colorLabelSnapshot:
          v.offerColor?.nameAr ??
          (v.colorCode ? (colorLabel.get(v.colorCode) ?? v.colorCode) : null),
        offerColorIdSnapshot: v.offerColor?.id ?? null,
        colorNameArSnapshot:
          v.offerColor?.nameAr ??
          (v.colorCode ? (colorLabel.get(v.colorCode) ?? v.colorCode) : null),
        colorNameEnSnapshot: v.offerColor?.nameEn ?? null,
        colorHexSnapshot: v.offerColor?.hex ?? null,
        colorSwatchUrlSnapshot: v.offerColor?.swatchUrl ?? null,
        sizeCodeSnapshot: v.sizeCode,
        sizeLabelSnapshot: v.sizeCode
          ? (sizeLabel.get(v.sizeCode) ?? v.sizeCode)
          : null,
      },
    ]),
  );
}
