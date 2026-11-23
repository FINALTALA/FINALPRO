"use client";

import { useParams, useRouter } from "next/navigation";
import { useEffect } from "react";
import { MINIMUM_ORDER_ANCHOR } from "@/components/owner/BranchMinimumOrderSection";

/**
 * «الحد الأدنى للطلب» moved into «إعدادات الفرع» (no tab of its own). The
 * old address stays valid: it opens the settings tab at that section.
 */
export default function BranchMinimumOrderRedirect() {
  const params = useParams<{ vendorId: string; branchId: string }>();
  const router = useRouter();
  useEffect(() => {
    router.replace(`/vendor/${params.vendorId}/branches/${params.branchId}/settings#${MINIMUM_ORDER_ANCHOR}`);
  }, [params.vendorId, params.branchId, router]);
  return <div className="skeleton" style={{ height: 160, width: "100%", maxWidth: 860 }} aria-busy="true" />;
}
