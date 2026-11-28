"use client";

import "@/lib/adminCatalogText";
import Link from "next/link";
import { useState } from "react";
import { EmptyState, ErrorBanner } from "@/components/States";
import { apiFetch, newIdempotencyKey } from "@/lib/api";
import { fillMp, mpDate, mpError, mpFetchError } from "@/lib/adminMarketplaceText";
import { useAdminGate } from "@/lib/useAdminGate";
import { useFetch } from "@/lib/useFetch";
import { useLang, useT } from "@/lib/useLang";

interface NameChangeRequest {
  id: string;
  canonical_product_id: string;
  vendor_id: string;
  requested_name_ar: string;
  requested_name_en: string;
  reason: string | null;
  status: string;
  created_at: string;
}

// Sprint 16 (FR-ADMIN-001, G-AD-03 partial): a screen over the EXISTING
// admin endpoints for canonical-product rename requests. It does not
// build any platform match-correction flow - there is no approved policy
// for that yet.
export default function NameChangeRequestsPage() {
  const gate = useAdminGate("ADMIN");
  const lang = useLang();
  const t = useT();
  const [nonce, setNonce] = useState(0);
  const requests = useFetch<NameChangeRequest[]>(
    gate.status === "ok" ? `/canonical-products/name-change-requests?r=${nonce}` : null,
    true,
  );
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  async function decide(id: string, decision: "approve" | "reject") {
    setBusyId(id);
    setError(null);
    setNotice(null);
    const note = (notes[id] ?? "").trim();
    try {
      await apiFetch(`/canonical-products/name-change-requests/${id}/decision`, {
        method: "POST",
        body: note ? { decision, note } : { decision },
        idempotencyKey: newIdempotencyKey("name-change-decision"),
      });
      setNotice(t(decision === "approve" ? "mpa.nc.approved" : "mpa.nc.rejected"));
      setNonce((n) => n + 1);
    } catch (err) {
      setError(mpError(err, lang));
    } finally {
      setBusyId(null);
    }
  }

  if (gate.status === "loading") {
    return (
      <div className="page-shell">
        <div className="skeleton" style={{ height: 120, width: "100%", maxWidth: 1000 }} />
      </div>
    );
  }
  if (gate.status === "forbidden" || requests.status === 403) {
    return (
      <div className="page-shell">
        <EmptyState title={t("mpa.cat.forbidden")} actionHref="/account" actionLabel={t("mpa.cat.myAccount")} />
      </div>
    );
  }

  return (
    <div className="page-shell">
      <div className="wide-shell" style={{ maxWidth: 1000 }}>
        <div className="top-bar">
          <h1 className="page-title" style={{ margin: 0 }}>{t("mpa.nc.title")}</h1>
          <Link href="/admin" className="button-link">{t("mpa.cat.dashboard")}</Link>
        </div>

        {(requests.error || error) && <ErrorBanner message={error ?? mpFetchError(requests.error, requests.apiError, lang) ?? ""} />}
        {notice && <div className="notice-banner" role="status">{notice}</div>}
        {requests.loading && !requests.data && (
          <div aria-busy="true" aria-label={t("mpa.cat.loading")}>
            <div className="skeleton" style={{ height: 120, width: "100%" }} />
          </div>
        )}
        {requests.data && requests.data.length === 0 && (
          <EmptyState title={t("mpa.nc.empty")} message={t("mpa.nc.emptyHint")} />
        )}
        {requests.data && requests.data.length > 0 && (
          <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
            {requests.data.map((r) => (
              <div key={r.id} className="card" style={{ maxWidth: "none" }}>
                <p style={{ margin: "0 0 4px" }}>
                  <strong>{r.requested_name_ar}</strong> - <span dir="ltr">{r.requested_name_en}</span>
                </p>
                <p className="muted" style={{ margin: "0 0 8px" }}>
                  {fillMp(t("mpa.nc.requestedAt"), { date: mpDate(r.created_at, lang) })}
                </p>
                {r.reason && <p style={{ whiteSpace: "pre-wrap" }}>{r.reason}</p>}
                <div className="field">
                  <label htmlFor={`note-${r.id}`}>{t("mpa.nc.note")}</label>
                  <textarea
                    id={`note-${r.id}`}
                    rows={2}
                    value={notes[r.id] ?? ""}
                    disabled={busyId !== null}
                    onChange={(e) => setNotes((prev) => ({ ...prev, [r.id]: e.target.value }))}
                  />
                </div>
                <div style={{ display: "flex", gap: 8 }}>
                  <button className="button" disabled={busyId !== null} onClick={() => decide(r.id, "approve")}>
                    {t("mpa.nc.approve")}
                  </button>
                  <button
                    className="button button-secondary"
                    disabled={busyId !== null}
                    onClick={() => decide(r.id, "reject")}
                  >
                    {t("mpa.nc.reject")}
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
