"use client";

import { useParams, useRouter } from "next/navigation";
import { useEffect } from "react";
import { BranchOverview, useBranchWorkspace } from "@/components/owner/BranchWorkspace";
import { EmptyState } from "@/components/States";
import "@/lib/branchesText";
import { loginRedirectHref } from "@/lib/loginRedirect";
import { useT } from "@/lib/useLang";

/**
 * A branch's «نظرة عامة» (the employee's workspace of her own branch, or a
 * branch the owner switched to) - under the branch dashboard of layout.tsx.
 */
export default function BranchHomePage() {
  const params = useParams<{ vendorId: string; branchId: string }>();
  const router = useRouter();
  const t = useT();
  const ws = useBranchWorkspace(params.vendorId);

  useEffect(() => {
    if (ws.hydrated && !ws.token) router.replace(loginRedirectHref());
  }, [ws.hydrated, ws.token, router]);

  const branch = ws.branches?.find((b) => b.id === params.branchId) ?? null;
  if (ws.ready && (ws.branches || ws.error !== null) && !branch) {
    return (
      <div className="page-shell">
        <EmptyState title={t("br.no_access")} actionHref="/account" actionLabel={t("br.account")} />
      </div>
    );
  }
  if (!ws.ready || !branch) return <div className="skeleton" style={{ height: 220, width: "100%" }} />;
  return <BranchOverview vendorId={params.vendorId} ws={ws} branch={branch} />;
}
