"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { useState } from "react";
import { EmptyState, ErrorBanner } from "@/components/States";
import { apiFetch, newIdempotencyKey } from "@/lib/api";
import {
  STORE_TYPE_LABEL,
  SUSPENSION_REASON_LABEL,
  VENDOR_STATUS_LABEL,
  adminErrorMessage,
  formatDateTime,
  reasonProblem,
} from "@/lib/admin";
import { useAdminGate } from "@/lib/useAdminGate";
import { useFetch } from "@/lib/useFetch";

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
export default function AdminVendorDetailPage() {
  const gate = useAdminGate("ADMIN");
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
  const problem = reasonProblem(reason);

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
      setNotice(kind === "suspend" ? "تم تعليق المتجر." : "تمت إعادة تفعيل المتجر.");
      setPanel("none");
      setReason("");
      setNonce((n) => n + 1);
    } catch (err) {
      setError(adminErrorMessage(err));
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
        <EmptyState title="هذه الصفحة لمدير المنصة فقط" actionHref="/account" actionLabel="حسابي" />
      </div>
    );
  }
  if (vendor.status === 404) {
    return (
      <div className="page-shell">
        <EmptyState title="المتجر غير موجود" actionHref="/admin/vendors" actionLabel="قائمة المتاجر" />
      </div>
    );
  }

  const v = vendor.data;
  return (
    <div className="page-shell">
      <div className="wide-shell" style={{ maxWidth: 800 }}>
        <div className="top-bar">
          <h1 className="page-title" style={{ margin: 0 }}>{v ? v.legal_name : "تفاصيل المتجر"}</h1>
          <Link href="/admin/vendors" className="button-link">قائمة المتاجر</Link>
        </div>

        {vendor.error && <ErrorBanner message={vendor.error} />}
        {notice && <div className="notice-banner" role="status">{notice}</div>}
        {vendor.loading && !v && (
          <div aria-busy="true" aria-label="جارٍ التحميل">
            <div className="skeleton" style={{ height: 160, width: "100%" }} />
          </div>
        )}

        {v && (
          <>
            <div className="card" style={{ maxWidth: "none", marginBottom: 14 }}>
              <p>
                <span className={`badge${v.status === "ACTIVE" ? " badge-active" : ""}`}>
                  {VENDOR_STATUS_LABEL[v.status] ?? v.status}
                </span>{" "}
                <span className="muted">
                  {STORE_TYPE_LABEL[v.store_type] ?? v.store_type} - أُنشئ في {formatDateTime(v.created_at)}
                </span>
              </p>
              <p className="muted">الطلبات الجارية لهذا المتجر: {v.active_branch_orders_count}</p>

              {v.is_member ? (
                <div className="warning-banner">
                  أنتِ عضوة في هذا المتجر، لذلك لا يمكنك تعليقه أو إعادة تفعيله.
                </div>
              ) : (
                <>
                  {v.status === "ACTIVE" && panel === "none" && (
                    <button className="button" onClick={() => openPanel("suspend")}>تعليق المتجر</button>
                  )}
                  {v.status === "SUSPENDED" && panel === "none" && (
                    <button className="button" onClick={() => openPanel("reactivate")}>إعادة تفعيل المتجر</button>
                  )}
                  {v.status !== "ACTIVE" && v.status !== "SUSPENDED" && (
                    <p className="muted">لا يمكن تعليق إلا متجر نشط.</p>
                  )}
                </>
              )}

              {panel !== "none" && (
                <div style={{ marginTop: 14 }}>
                  {panel === "suspend" && (
                    <div className="warning-banner">
                      التعليق يُخفي المتجر ويمنع الطلبات الجديدة وتعديل المنتجات، لكن الطلبات الجارية
                      ({v.active_branch_orders_count}) يستمر تنفيذها.
                    </div>
                  )}
                  {error && <ErrorBanner message={error} />}
                  {panel === "suspend" && (
                    <div className="field">
                      <label htmlFor="reason-code">نوع السبب</label>
                      <select id="reason-code" value={reasonCode} disabled={busy} onChange={(e) => setReasonCode(e.target.value)}>
                        {Object.entries(SUSPENSION_REASON_LABEL).map(([k, label]) => (
                          <option key={k} value={k}>{label}</option>
                        ))}
                      </select>
                    </div>
                  )}
                  <div className="field">
                    <label htmlFor="reason">
                      {panel === "suspend" ? "سبب التعليق (يراه المالك)" : "سبب إعادة التفعيل"}
                    </label>
                    <textarea id="reason" rows={4} value={reason} disabled={busy} onChange={(e) => setReason(e.target.value)} />
                    <span className="muted">{reason.trim().length} / 1000</span>
                    {problem && reason.length > 0 && <span className="field-error">{problem}</span>}
                  </div>
                  <div style={{ display: "flex", gap: 8 }}>
                    <button className="button" disabled={busy || problem !== null} onClick={() => submit(panel)}>
                      {busy ? "جارٍ الإرسال..." : panel === "suspend" ? "تأكيد التعليق" : "تأكيد إعادة التفعيل"}
                    </button>
                    <button className="button button-secondary" disabled={busy} onClick={() => openPanel("none")}>
                      إلغاء
                    </button>
                  </div>
                </div>
              )}
            </div>

            <div className="card" style={{ maxWidth: "none" }}>
              <h2 style={{ marginTop: 0 }}>سجل التعليق</h2>
              {v.suspensions.length === 0 ? (
                <p className="muted">لم يُعلَّق هذا المتجر من قبل.</p>
              ) : (
                <div style={{ overflowX: "auto" }}>
<table className="data-table">
                  <thead>
                    <tr>
                      <th>السبب</th>
                      <th>التعليق</th>
                      <th>إعادة التفعيل</th>
                    </tr>
                  </thead>
                  <tbody>
                    {v.suspensions.map((s) => (
                      <tr key={s.id}>
                        <td>
                          <strong>{SUSPENSION_REASON_LABEL[s.reason_code] ?? s.reason_code}</strong>
                          <br />
                          <span className="muted">{s.reason}</span>
                        </td>
                        <td>{formatDateTime(s.suspended_at)}</td>
                        <td>
                          {s.reactivated_at ? (
                            <>
                              {formatDateTime(s.reactivated_at)}
                              <br />
                              <span className="muted">{s.reactivation_reason}</span>
                            </>
                          ) : (
                            <span className="badge">ما زال معلَّقاً</span>
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
