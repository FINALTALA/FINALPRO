import { Prisma } from '../../generated/prisma/client';

/**
 * PD-4 closing round (decision 6): the size-guide version an order line
 * was bought under, as shown in the order and return screens. Read-only
 * and never re-resolved - an order placed before PD-4 (or with no
 * published guide) has no snapshot and shows nothing.
 */
export const SIZE_GUIDE_SNAPSHOT_SELECT = {
  id: true,
  version: true,
  publishedAt: true,
  guide: { select: { id: true, nameAr: true, nameEn: true } },
} satisfies Prisma.SizeGuideVersionSelect;

type SnapshotRow = Prisma.SizeGuideVersionGetPayload<{
  select: typeof SIZE_GUIDE_SNAPSHOT_SELECT;
}>;

export function sizeGuideSnapshotDto(v: SnapshotRow | null | undefined) {
  if (!v) return null;
  return {
    guide_id: v.guide.id,
    version_id: v.id,
    version: v.version,
    name_ar: v.guide.nameAr,
    name_en: v.guide.nameEn,
    published_at: v.publishedAt?.toISOString() ?? null,
  };
}
