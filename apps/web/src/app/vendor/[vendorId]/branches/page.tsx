"use client";

import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useEffect } from "react";
import { BranchOverview, BranchShell, readCurrentBranch, useBranchWorkspace } from "@/components/owner/BranchWorkspace";
import { EmptyState, ErrorBanner } from "@/components/States";
import "@/lib/branchesText";
import { loginRedirectHref } from "@/lib/loginRedirect";
import { useT } from "@/lib/useLang";

/**
 * «إدارة الفروع» (2026-11-20): opens on the store's CURRENT branch - the
 * owner's last choice on this device (else the first active branch), the
 * employee's own branch - as the branch dashboard's «نظرة عامة». Its tools
 * and the picker live in BranchShell; each tool is the existing branch screen.
 */
export default function BranchesPage() {
  const params = useParams<{ vendorId: string }>();
  const router = useRouter();
  const t = useT();
  const ws = useBranchWorkspace(params.vendorId);

  useEffect(() => {
    if (ws.hydrated && !ws.token) router.replace(loginRedirectHref());
  }, [ws.hydrated, ws.token, router]);

  if (!ws.ready || (!ws.branches && ws.error === null)) {
    return (
      <div className="page-shell">
        <div className="skeleton" style={{ height: 160, width: "100%", maxWidth: 1100 }} />
      </div>
    );
  }
  if (ws.error !== null) return <div className="page-shell"><ErrorBanner message={ws.error || t("br.load_failed")} /></div>;

  const wanted = ws.isOwner ? readCurrentBranch(params.vendorId) : ws.ownBranchId;
  const pool = ws.isOwner ? ws.active : (ws.branches ?? []);
  const current = pool.find((b) => b.id === wanted) ?? pool[0] ?? null;

  if (!current) {
    return (
      <div className="page-shell br-ws" data-testid="branches-page">
        <div className="br-empty">
          <EmptyState title={t("br.none")} />
          {ws.isOwner && (
            <>
              <p className="muted">{t("br.none_hint")}</p>
              <Link href={`/vendor/${params.vendorId}/branches/new`} className="button owner-primary" data-testid="br-add-first">{t("br.add")}</Link>
            </>
          )}
        </div>
      </div>
    );
  }
  return (
    <div data-testid="branches-page">
      <BranchShell vendorId={params.vendorId} ws={ws} current={current} view="overview">
        <BranchOverview vendorId={params.vendorId} ws={ws} branch={current} />
      </BranchShell>
    </div>
  );
}
