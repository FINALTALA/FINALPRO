"use client";

import "@/lib/adminStoreDetailText";
import Link from "next/link";
import { useParams } from "next/navigation";
import { useState } from "react";
import { EmptyState, ErrorBanner } from "@/components/States";
import { apiFetch, newIdempotencyKey } from "@/lib/api";
import {
  fillMp,
  mpDate,
  mpError,
  mpFetchError,
  mpLabel,
  mpLabelEntries,
  mpReasonProblem,
} from "@/lib/adminMarketplaceText";
import { useAdminGate } from "@/lib/useAdminGate";
import { useFetch } from "@/lib/useFetch";
import { useLang, useT } from "@/lib/useLang";

interface SuspensionRow {
  id: string;
  reason_code: string;
  reason: string;
  suspended_by: string;
  suspended_at: string;
  reactivated_by: string | null;
  reactivated_at: string | null;
  reactivation_reason: string | null;
}

interface VendorDetail {
  id: string;
  legal_name: string;
  store_type: string;
  status: string;
  created_at: string;
  is_member: boolean;
  active_branch_orders_count: number;
  suspensions: SuspensionRow[];
}

type Panel = "none" | "suspend" | "reactivate";

// Sprint 16 (FR-VEND-009, L-23): vendor detail with suspend / reactivate.
// Suspension hides the store and blocks new orders and catalog edits, but
// already-placed orders keep being fulfilled - the confirm step says so.
// M-01: every label follows the UI language (lib/adminStoreDetailText.ts).
export default function AdminVendorDetailPage() {
  const gate = useAdminGate("ADMIN");
  const lang = useLang();
  const t = useT();
  const params = useParams<{ vendorId: string }>();
  const [nonce, setNonce] = useState(0);
  const vendor = useFetch<VendorDetail>(
    gate.status === "ok" ? `/admin/vendors/${params.vendorId}?r=${nonce}` : null,
    true,
  );
  const [panel, setPanel] = useState<Panel>("none");
  const [reasonCode, setReasonCode] = useState("POLICY_VIOLATION");
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const problem = mpReasonProblem(reason, lang);

  function openPanel(next: Panel) {
    setPanel(next);
    setReason("");
    setError(null);
    setNotice(null);
  }

  async function submit(kind: "suspend" | "reactivate") {
    if (problem) return;
    setBusy(true);
    setError(null);
    try {
      await apiFetch(`/admin/vendors/${params.vendorId}/${kind}`, {
        method: "POST",
        body:
          kind === "suspend"
            ? { reason_code: reasonCode, reason: reason.trim() }
            : { reason: reason.trim() },
        idempotencyKey: newIdempotencyKey(`vendor-${kind}`),
      });
      setNotice(t(kind === "suspend" ? "mpa.sd.vendor.suspended" : "mpa.sd.vendor.reactivated"));
      setPanel("none");
      setReason("");
      setNonce((n) => n + 1);
    } catch (err) {
      setError(mpError(err, lang));
    } finally {
      setBusy(false);
    }
  }

  if (gate.status === "loading") {
    return (
      <div className="page-shell">
        <div className="skeleton" style={{ height: 160, width: "100%", maxWidth: 800 }} />
      </div>
    );
  }
  if (gate.status === "forbidden" || vendor.status === 403) {
    return (
      <div className="page-shell">
        <EmptyState title={t("mpa.sd.forbiddenAdmin")} actionHref="/account" actionLabel={t("mpa.sd.myAccount")} />
      </div>
    );
  }
  if (vendor.status === 404) {
    return (
      <div className="page-shell">
        <EmptyState title={t("mpa.sd.vendor.notFound")} actionHref="/admin/vendors" actionLabel={t("mpa.sd.vendor.list")} />
      </div>
    );
  }

  const v = vendor.data;
  const loadError = mpFetchError(vendor.error, vendor.apiError, lang);
  return (
    <div className="page-shell">
      <div className="wide-shell" style={{ maxWidth: 800 }}>
        <div className="top-bar">
          <h1 className="page-title" style={{ margin: 0 }}>{v ? v.legal_name : t("mpa.sd.vendor.titleFallback")}</h1>
          <Link href="/admin/vendors" className="button-link">{t("mpa.sd.vendor.list")}</Link>
        </div>

        {loadError && <ErrorBanner message={loadError} />}
        {notice && <div className="notice-banner" role="status">{notice}</div>}
        {vendor.loading && !v && (
          <div aria-busy="true" aria-label={t("mpa.sd.loading")}>
            <div className="skeleton" style={{ height: 160, width: "100%" }} />
          </div>
        )}

        {v && (
          <>
            <div className="card" style={{ maxWidth: "none", marginBottom: 14 }}>
              <p>
                <span className={`badge${v.status === "ACTIVE" ? " badge-active" : ""}`}>
                  {mpLabel(lang, "storeStatus", v.status)}
                </span>{" "}
                <span className="muted">
                  {fillMp(t("mpa.sd.vendor.meta"), {
                    type: mpLabel(lang, "storeType", v.store_type),
                    date: mpDate(v.created_at, lang),
                  })}
                </span>
              </p>
              <p className="muted">{fillMp(t("mpa.sd.vendor.activeOrders"), { n: v.active_branch_orders_count })}</p>

              {v.is_member ? (
                <div className="warning-banner">{t("mpa.sd.vendor.isMember")}</div>
              ) : (
                <>
                  {v.status === "ACTIVE" && panel === "none" && (
                    <button className="button" onClick={() => openPanel("suspend")}>{t("mpa.sd.vendor.suspend")}</button>
                  )}
                  {v.status === "SUSPENDED" && panel === "none" && (
                    <button className="button" onClick={() => openPanel("reactivate")}>{t("mpa.sd.vendor.reactivate")}</button>
                  )}
                  {v.status !== "ACTIVE" && v.status !== "SUSPENDED" && (
                    <p className="muted">{t("mpa.sd.vendor.onlyActive")}</p>
                  )}
                </>
              )}

              {panel !== "none" && (
                <div style={{ marginTop: 14 }}>
                  {panel === "suspend" && (
                    <div className="warning-banner">
                      {fillMp(t("mpa.sd.vendor.suspendWarning"), { n: v.active_branch_orders_count })}
                    </div>
                  )}
                  {error && <ErrorBanner message={error} />}
                  {panel === "suspend" && (
                    <div className="field">
                      <label htmlFor="reason-code">{t("mpa.sd.vendor.reasonCode")}</label>
                      <select id="reason-code" value={reasonCode} disabled={busy} onChange={(e) => setReasonCode(e.target.value)}>
                        {mpLabelEntries(lang, "suspensionReason").map(([k, label]) => (
                          <option key={k} value={k}>{label}</option>
                        ))}
                      </select>
                    </div>
                  )}
                  <div className="field">
                    <label htmlFor="reason">
                      {t(panel === "suspend" ? "mpa.sd.vendor.suspendReason" : "mpa.sd.vendor.reactivateReason")}
                    </label>
                    <textarea id="reason" rows={4} value={reason} disabled={busy} onChange={(e) => setReason(e.target.value)} />
                    <span className="muted">{reason.trim().length} / 1000</span>
                    {problem && reason.length > 0 && <span className="field-error">{problem}</span>}
                  </div>
                  <div style={{ display: "flex", gap: 8 }}>
                    <button className="button" disabled={busy || problem !== null} onClick={() => submit(panel)}>
                      {busy
                        ? t("mpa.sd.sending")
                        : t(panel === "suspend" ? "mpa.sd.vendor.confirmSuspend" : "mpa.sd.vendor.confirmReactivate")}
                    </button>
                    <button className="button button-secondary" disabled={busy} onClick={() => openPanel("none")}>
                      {t("mpa.sd.cancel")}
                    </button>
                  </div>
                </div>
              )}
            </div>

            <div className="card" style={{ maxWidth: "none" }}>
              <h2 style={{ marginTop: 0 }}>{t("mpa.sd.vendor.history")}</h2>
              {v.suspensions.length === 0 ? (
                <p className="muted">{t("mpa.sd.vendor.neverSuspended")}</p>
              ) : (
                <div style={{ overflowX: "auto" }}>
<table className="data-table">
                  <thead>
                    <tr>
                      <th>{t("mpa.sd.vendor.colReason")}</th>
                      <th>{t("mpa.sd.vendor.colSuspended")}</th>
                      <th>{t("mpa.sd.vendor.colReactivated")}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {v.suspensions.map((s) => (
                      <tr key={s.id}>
                        <td>
                          <strong>{mpLabel(lang, "suspensionReason", s.reason_code)}</strong>
                          <br />
                          <span className="muted">{s.reason}</span>
                        </td>
                        <td>{mpDate(s.suspended_at, lang)}</td>
                        <td>
                          {s.reactivated_at ? (
                            <>
                              {mpDate(s.reactivated_at, lang)}
                              <br />
                              <span className="muted">{s.reactivation_reason}</span>
                            </>
                          ) : (
                            <span className="badge">{t("mpa.sd.vendor.stillSuspended")}</span>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
</div>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
