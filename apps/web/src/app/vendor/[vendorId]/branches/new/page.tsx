"use client";

import { useParams, useRouter } from "next/navigation";
import { useEffect, useState, type FormEvent } from "react";
import { useBranchWorkspace, writeCurrentBranch } from "@/components/owner/BranchWorkspace";
import { EmptyState, ErrorBanner } from "@/components/States";
import { ApiError, apiFetch, newIdempotencyKey } from "@/lib/api";
import "@/lib/branchesText";
import { loginRedirectHref } from "@/lib/loginRedirect";
import { useT } from "@/lib/useLang";

/**
 * «إضافة فرع» (owner): the existing add form - the same request and checks -
 * as its own screen of the management window. Once added, the new branch
 * becomes the current one and «إدارة الفروع» opens on it.
 */
export default function AddBranchPage() {
  const params = useParams<{ vendorId: string }>();
  const router = useRouter();
  const t = useT();
  const ws = useBranchWorkspace(params.vendorId);
  const [name, setName] = useState("");
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (ws.hydrated && !ws.token) router.replace(loginRedirectHref());
  }, [ws.hydrated, ws.token, router]);

  if (!ws.ready) {
    return (
      <div className="page-shell">
        <div className="skeleton" style={{ height: 160, width: "100%", maxWidth: 640 }} />
      </div>
    );
  }
  if (!ws.isOwner) return <div className="page-shell"><EmptyState title={t("br.add.owner_only")} /></div>;

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!name.trim()) {
      setError(t("br.add.required"));
      return;
    }
    setAdding(true);
    setError(null);
    try {
      const created = await apiFetch<{ id?: string }>(`/vendors/${params.vendorId}/branches`, {
        method: "POST",
        body: { name: name.trim() },
        idempotencyKey: newIdempotencyKey("branch-add"),
      });
      if (created?.id) writeCurrentBranch(params.vendorId, created.id);
      router.replace(`/vendor/${params.vendorId}/branches`);
    } catch (err) {
      setError(err instanceof ApiError && err.message ? err.message : t("br.add.failed"));
      setAdding(false);
    }
  }

  return (
    <div className="page-shell br-ws">
      <h1 className="br-page-title">{t("br.add")}</h1>
      <form className="br-card br-add-form" onSubmit={(e) => void submit(e)} data-testid="br-add-form">
        <p className="muted">{t("br.add.lead")}</p>
        {error && <ErrorBanner message={error} />}
        <label htmlFor="br-add-name" className="br-field-label">{t("br.add.name")}</label>
        <input id="br-add-name" className="br-input" value={name} onChange={(e) => setName(e.target.value)} autoFocus data-testid="br-add-name" />
        <div className="br-form-actions">
          <button type="submit" className="button owner-primary" disabled={adding} aria-busy={adding} data-testid="br-add-submit">
            {adding ? t("br.add.adding") : t("br.add.submit")}
          </button>
        </div>
      </form>
    </div>
  );
}
