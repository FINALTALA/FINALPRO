"use client";

import { useParams, useRouter } from "next/navigation";
import { useEffect } from "react";
import { useBranchWorkspace } from "@/components/owner/BranchWorkspace";
import { loginRedirectHref } from "@/lib/loginRedirect";

/**
 * An old owner address that is now a view of «أداء المتجر» (/reviews, /sales):
 * once the session is known, opens that view (an expired session signs in
 * first and comes back to the old address, like every workspace page).
 */
export default function PerformanceRedirect({ view, hash = "", testId }: { view: "sales" | "customers"; hash?: string; testId: string }) {
  const params = useParams<{ vendorId: string }>();
  const router = useRouter();
  const ws = useBranchWorkspace(params.vendorId);
  useEffect(() => {
    if (ws.hydrated && !ws.token) {
      router.replace(loginRedirectHref());
      return;
    }
    if (!ws.ready) return;
    router.replace(`/vendor/${params.vendorId}/performance?view=${view}${hash ? `#${hash}` : ""}`);
  }, [ws.hydrated, ws.token, ws.ready, params.vendorId, router, view, hash]);
  return <div className="skeleton" style={{ height: 200, width: "100%", maxWidth: 980 }} aria-busy="true" data-testid={testId} />;
}
