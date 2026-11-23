"use client";

import { useParams, useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import BranchMinimumOrderSection from "@/components/owner/BranchMinimumOrderSection";
import { BRANCHES_CHANGED, useBranchWorkspace, writeCurrentBranch } from "@/components/owner/BranchWorkspace";
import { EmptyState, ErrorBanner } from "@/components/States";
import { ApiError, apiFetch, newIdempotencyKey } from "@/lib/api";
import "@/lib/branchesText";
import { fillBr } from "@/lib/branchesText";
import { loginRedirectHref } from "@/lib/loginRedirect";
import { useT } from "@/lib/useLang";

/**
 * «إعدادات الفرع» (owner; the gear beside the branch picker - not a tab): the branch as the list knows it, its
 * «الحد الأدنى للطلب» (moved here from its own tab), and the
 * archive action that used to sit on each branch card - the same request; the
 * server's own refusals are shown as they come (no client-side rules).
 */
export default function BranchSettingsPage() {
  const params = useParams<{ vendorId: string; branchId: string }>();
  const router = useRouter();
  const t = useT();
  const ws = useBranchWorkspace(params.vendorId);
  const [asking, setAsking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (ws.hydrated && !ws.token) router.replace(loginRedirectHref());
  }, [ws.hydrated, ws.token, router]);

  const branch = ws.branches?.find((b) => b.id === params.branchId) ?? null;
  if (!ws.ready || !ws.branches) {
    return (
      <div className="page-shell">
        <div className="skeleton" style={{ height: 160, width: "100%", maxWidth: 900 }} />
      </div>
    );
  }
  if (!ws.isOwner || !branch) return <div className="page-shell"><EmptyState title={t("br.no_access")} /></div>;

  async function archive() {
    if (!branch) return;
    setBusy(true);
    setError(null);
    try {
      await apiFetch(`/vendors/${params.vendorId}/branches/${branch.id}/archive`, {
        method: "POST",
        body: {},
        idempotencyKey: newIdempotencyKey(`branch-archive-${branch.id}`),
      });
      writeCurrentBranch(params.vendorId, null);
      setAsking(false);
      window.dispatchEvent(new Event(BRANCHES_CHANGED));
    } catch (err) {
      setError(err instanceof ApiError && err.message ? err.message : t("br.settings.archive_failed"));
    } finally {
      setBusy(false);
    }
  }

  const v = `br.v.${branch.verification_status}`;
  return (
    <div className="br-pane">
      <section className="br-card" data-testid="br-settings">
        <h2 dir="auto">{branch.name}</h2>
        <dl className="br-facts">
          <div>
            <dt>{t("br.kind")}</dt>
            <dd>{branch.is_physical ? t("br.kind.physical") : t("br.kind.fulfilment")}</dd>
          </div>
          <div>
            <dt>{t("br.verification")}</dt>
            <dd>{t(v) !== v ? t(v) : branch.verification_status}</dd>
          </div>
          <div>
            <dt>{t("br.state")}</dt>
            <dd data-testid="br-settings-state">{branch.archived_at ? t("br.state.archived") : t("br.state.active")}</dd>
          </div>
        </dl>
        {branch.archived_at && <p className="muted br-settings-note" data-testid="br-settings-archived-note">{t("br.settings.archived_note")}</p>}
      </section>
      {!branch.archived_at && <BranchMinimumOrderSection vendorId={params.vendorId} branchId={branch.id} />}
      <section className="br-card br-danger" aria-labelledby="br-archive-title">
        <h2 id="br-archive-title">{t("br.settings.archive")}</h2>
        {error && <ErrorBanner message={error} />}
        {branch.archived_at ? (
          <p className="muted" data-testid="br-archived">{t("br.settings.archived")}</p>
        ) : (
          <>
            <p className="muted">{t("br.settings.archive_lead")}</p>
            {!asking ? (
              <button type="button" className="button-link br-archive" onClick={() => setAsking(true)} data-testid="br-archive">
                {t("br.settings.archive")}
              </button>
            ) : (
              <div className="br-confirm" role="group" aria-label={fillBr(t("br.settings.archive_confirm"), { name: branch.name })}>
                <strong>{fillBr(t("br.settings.archive_confirm"), { name: branch.name })}</strong>
                <button type="button" className="button br-archive-yes" disabled={busy} aria-busy={busy} onClick={() => void archive()} data-testid="br-archive-yes">
                  {busy ? t("br.settings.archiving") : t("br.settings.archive")}
                </button>
                <button type="button" className="button-link" disabled={busy} onClick={() => setAsking(false)}>{t("br.settings.cancel")}</button>
              </div>
            )}
          </>
        )}
      </section>
    </div>
  );
}
