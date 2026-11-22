"use client";

import { SizeGuideSnapshot } from "@/lib/sizeGuides";
import { useLang } from "@/lib/useLang";

/**
 * PD-4 (decision 6): states which size-guide version an order line was
 * bought under, where an order or a return is reviewed. Renders nothing
 * for a line with no snapshot (older orders, or no published guide).
 */
export default function SizeGuideSnapshotNote({ snapshot }: { snapshot: SizeGuideSnapshot | null | undefined }) {
  const lang = useLang();
  if (!snapshot) return null;
  return (
    <span className="size-guide-snapshot">
      {lang === "en"
        ? `Bought under size guide “${snapshot.name_en || snapshot.name_ar}”, version ${snapshot.version}`
        : `تم الشراء وفق دليل المقاسات «${snapshot.name_ar}» - الإصدار ${snapshot.version}`}
    </span>
  );
}
