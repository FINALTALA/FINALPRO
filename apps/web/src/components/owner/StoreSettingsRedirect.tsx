"use client";

import { useParams, useRouter } from "next/navigation";
import { useEffect } from "react";
import { useBranchWorkspace } from "@/components/owner/BranchWorkspace";
import { loginRedirectHref } from "@/lib/loginRedirect";

/**
 * An old store-level address of a setting that now lives in «إعدادات المتجر»:
 * once the session is known, opens that page at the section (an expired
 * session signs in first and comes back to the old address, like every
 * workspace page).
 */
export default function StoreSettingsRedirect({ section, testId }: { section: "delivery" | "returns"; testId: string }) {
  const params = useParams<{ vendorId: string }>();
  const router = useRouter();
  const ws = useBranchWorkspace(params.vendorId);
  useEffect(() => {
    if (ws.hydrated && !ws.token) {
      router.replace(loginRedirectHref());
      return;
    }
    if (!ws.ready) return;
    router.replace(`/vendor/${params.vendorId}/settings#${section}`);
  }, [ws.hydrated, ws.token, ws.ready, params.vendorId, router, section]);
  return <div className="skeleton" style={{ height: 200, width: "100%", maxWidth: 900 }} aria-busy="true" data-testid={testId} />;
}
