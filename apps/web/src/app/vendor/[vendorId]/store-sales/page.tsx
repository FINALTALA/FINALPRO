"use client";

import { useParams, useRouter } from "next/navigation";
import { useEffect } from "react";
import { useBranchWorkspace } from "@/components/owner/BranchWorkspace";
import StoreSalesLog from "@/components/pos/StoreSalesLog";
import { loginRedirectHref } from "@/lib/loginRedirect";

/**
 * «مبيعات المحل» (sales log of «بيع من المحل»). The OWNER reads it in «أداء
 * المتجر» › «المبيعات» now - this address goes there. The branch
 * employee keeps this page, for their own branch, exactly as before (their
 * workspace card and the cashier's «عرض» lead here).
 */
export default function StoreSalesPage() {
  const params = useParams<{ vendorId: string }>();
  const router = useRouter();
  const ws = useBranchWorkspace(params.vendorId);
  useEffect(() => {
    if (ws.hydrated && !ws.token) {
      router.replace(loginRedirectHref());
      return;
    }
    if (ws.ready && ws.isOwner) router.replace(`/vendor/${params.vendorId}/performance?view=sales#store-sales`);
  }, [ws.hydrated, ws.token, ws.ready, ws.isOwner, params.vendorId, router]);
  if (!ws.ready || ws.isOwner) return <div className="skeleton" style={{ height: 200, width: "100%", maxWidth: 980 }} aria-busy="true" data-testid="store-sales-redirect" />;
  return <StoreSalesLog vendorId={params.vendorId} />;
}
