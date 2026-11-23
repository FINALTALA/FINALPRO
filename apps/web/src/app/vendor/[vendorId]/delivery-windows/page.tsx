"use client";

import { useParams, useRouter } from "next/navigation";
import { useEffect } from "react";
import { useBranchWorkspace } from "@/components/owner/BranchWorkspace";
import { loginRedirectHref } from "@/lib/loginRedirect";

/**
 * «نوافذ التوصيل v1»: the old store-level address now opens the «نوافذ
 * التوصيل» tab of «إدارة الفروع» - the employee's own branch, or the owner's
 * first active branch (the branch switcher in the header changes it). No
 * branch yet -> the branches page.
 */
export default function DeliveryWindowsRedirectPage() {
  const params = useParams<{ vendorId: string }>();
  const router = useRouter();
  const ws = useBranchWorkspace(params.vendorId);

  useEffect(() => {
    if (ws.hydrated && !ws.token) {
      router.replace(loginRedirectHref());
      return;
    }
    if (!ws.ready) return;
    if (ws.ownBranchId) {
      router.replace(`/vendor/${params.vendorId}/branches/${ws.ownBranchId}/delivery-windows`);
      return;
    }
    if (ws.branches === null && !ws.error) return;
    const first = ws.active[0];
    router.replace(first ? `/vendor/${params.vendorId}/branches/${first.id}/delivery-windows` : `/vendor/${params.vendorId}/branches`);
  }, [ws.hydrated, ws.token, ws.ready, ws.ownBranchId, ws.branches, ws.active, ws.error, params.vendorId, router]);

  return <div className="skeleton" style={{ height: 240, width: "100%" }} aria-busy="true" data-testid="dw-redirect" />;
}
