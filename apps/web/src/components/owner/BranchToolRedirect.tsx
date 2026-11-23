"use client";

import { useParams, useRouter } from "next/navigation";
import { useEffect } from "react";
import { readCurrentBranch, useBranchWorkspace } from "@/components/owner/BranchWorkspace";
import { loginRedirectHref } from "@/lib/loginRedirect";

/**
 * An old store-level address that now lives inside «إدارة الفروع»: opens that
 * tool of the employee's own branch, or of the owner's current branch (the
 * one the dashboard last showed), else the first active one. No branch yet
 * -> the branches page. `query` is kept as given (e.g. ?redeem=1); `ownerQuery`
 * is added for the owner only (e.g. scope=all).
 */
export default function BranchToolRedirect({ tool, query = "", ownerQuery = "", testId }: { tool: string; query?: string; ownerQuery?: string; testId: string }) {
  const params = useParams<{ vendorId: string }>();
  const router = useRouter();
  const ws = useBranchWorkspace(params.vendorId);

  useEffect(() => {
    if (ws.hydrated && !ws.token) {
      router.replace(loginRedirectHref());
      return;
    }
    if (!ws.ready) return;
    const to = (branchId: string, owner: boolean) => {
      const q = [query, owner ? ownerQuery : ""].filter(Boolean).join("&");
      router.replace(`/vendor/${params.vendorId}/branches/${branchId}/${tool}${q ? `?${q}` : ""}`);
    };
    if (ws.ownBranchId) return to(ws.ownBranchId, false);
    if (ws.branches === null && !ws.error) return;
    const remembered = readCurrentBranch(params.vendorId);
    const current = ws.active.find((b) => b.id === remembered) ?? ws.active[0];
    if (current) to(current.id, ws.isOwner);
    else router.replace(`/vendor/${params.vendorId}/branches`);
  }, [ws.hydrated, ws.token, ws.ready, ws.ownBranchId, ws.branches, ws.active, ws.error, ws.isOwner, params.vendorId, router, tool, query, ownerQuery]);

  return <div className="skeleton" style={{ height: 240, width: "100%" }} aria-busy="true" data-testid={testId} />;
}
