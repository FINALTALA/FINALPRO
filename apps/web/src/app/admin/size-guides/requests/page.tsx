"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { EmptyState, ErrorBanner } from "@/components/States";
import { apiFetch, newIdempotencyKey } from "@/lib/api";
import { adminErrorMessage, formatDateTime, isForbidden } from "@/lib/admin";
import { AdminSizeGuideSummary, AUDIENCE_LABEL_AR, sizeGuideAdminError } from "@/lib/sizeGuides";
import { useTaxonomy } from "@/lib/taxonomy";
import { useAdminGate } from "@/lib/useAdminGate";

type Status = "PENDING" | "RESOLVED" | "REJECTED";
const STATUS_LABEL: Record<Status, string> = { PENDING: "بانتظار القرار", RESOLVED: "تمت الموافقة", REJECTED: "مرفوض" };

interface AdminRequest {
  id: string;
  message: string;
  status: Status;
  decision_note: string | null;
  decided_at: string | null;
  created_at: string;
  offer: {
    id: string;
    title: string;
    canonical_product_id: string | null;
    store: string;
    store_slug: string;
    audiences: string[];
    categories: string[];
  };
  resolved_guide: { id: string; code: string; name_ar: string } | null;
}

// PD-4 (decision 2): an owner's request for a custom size guide is only
// a request - the administrator creates the guide (or picks an existing
// published one) and links it here, or rejects with a reason.
export default function AdminSizeGuideRequestsPage() {
  const gate = useAdminGate("ADMIN");
  const taxonomy = useTaxonomy();
  const [status, setStatus] = useState<Status>("PENDING");
  const [items, setItems] = useState<AdminRequest[] | null>(null);
  const [guides, setGuides] = useState<AdminSizeGuideSummary[]>([]);
  const [choice, setChoice] = useState<Record<string, { guide_id: string; note: string }>>({});
  const [error, setError] = useState<string | null>(null);
  const [forbidden, setForbidden] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);

  useEffect(() => {
    if (gate.status !== "ok") return;
    let cancelled = false;
    apiFetch<AdminRequest[]>(`/admin/size-guide-requests?status=${status}`)
      .then((rows) => !cancelled && setItems(rows))
      .catch((err) => {
        if (cancelled) return;
        if (isForbidden(err)) setForbidden(true);
        setError(adminErrorMessage(err));
        setItems([]);
      });
    return () => {
      cancelled = true;
    };
  }, [gate.status, status]);

  useEffect(() => {
    if (gate.status !== "ok") return;
    apiFetch<AdminSizeGuideSummary[]>("/admin/size-guides")
      .then((g) => setGuides(g.filter((x) => x.published_version)))
      .catch(() => {});
  }, [gate.status]);

  const categoryName = (code: string) => taxonomy.data?.categories.find((c) => c.code === code)?.name_ar ?? code;

  /** Published guides that can apply to this offer: its product's guide, or a standard guide linked to its category/audience. */
  function candidates(r: AdminRequest) {
    return guides.filter((g) =>
      g.kind === "PRODUCT"
        ? g.canonical_product?.id === r.offer.canonical_product_id
        : g.applicability.some((p) => r.offer.categories.includes(p.category_code) && r.offer.audiences.includes(p.audience)),
    );
  }

  async function decide(r: AdminRequest, decision: "RESOLVED" | "REJECTED") {
    const c = choice[r.id] ?? { guide_id: "", note: "" };
    if (decision === "REJECTED" && !c.note.trim()) {
      setError("اكتبي سبب الرفض - يظهر للمالك.");
      return;
    }
    if (decision === "RESOLVED" && !c.guide_id) {
      setError("اختاري الدليل المنشور الذي يلبّي الطلب.");
      return;
    }
    setBusyId(r.id);
    setError(null);
    try {
      await apiFetch(`/admin/size-guide-requests/${r.id}`, {
        method: "PATCH",
        body: { decision, note: c.note.trim() || null, ...(decision === "RESOLVED" ? { guide_id: c.guide_id } : {}) },
        idempotencyKey: newIdempotencyKey("size-guide-request-decision"),
      });
      setItems((prev) => (prev ?? []).filter((x) => x.id !== r.id));
    } catch (err) {
      setError(sizeGuideAdminError(err));
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
  if (gate.status === "forbidden" || forbidden) {
    return (
      <div className="page-shell">
        <EmptyState title="هذه الصفحة لمدير المنصة فقط" actionHref="/account" actionLabel="حسابي" />
      </div>
    );
  }

  return (
    <div className="page-shell">
      <div className="wide-shell" style={{ maxWidth: 1000 }}>
        <div className="top-bar">
          <h1 className="page-title" style={{ margin: 0 }}>طلبات أدلة المقاسات</h1>
          <Link href="/admin/size-guides" className="button-link">أدلة المقاسات</Link>
        </div>

        <div className="admin-sg-filter" role="tablist" aria-label="الحالة">
          {(Object.keys(STATUS_LABEL) as Status[]).map((s) => (
            <button key={s} type="button" role="tab" aria-selected={status === s} className={status === s ? "button" : "button button-secondary"} onClick={() => {
              if (s === status) return;
              setItems(null);
              setStatus(s);
            }}>
              {STATUS_LABEL[s]}
            </button>
          ))}
        </div>

        {error && <ErrorBanner message={error} />}
        {!items ? (
          <div className="skeleton" style={{ height: 56, width: "100%" }} aria-busy="true" />
        ) : items.length === 0 ? (
          <EmptyState title={status === "PENDING" ? "لا توجد طلبات بانتظار القرار" : "لا توجد طلبات"} />
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
            {items.map((r) => {
              const c = choice[r.id] ?? { guide_id: "", note: "" };
              const options = candidates(r);
              return (
                <div key={r.id} className="card">
                  <div style={{ display: "flex", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
                    <strong>
                      <Link href={`/store/${r.offer.store_slug}/products/${r.offer.id}`}>{r.offer.title}</Link>
                    </strong>
                    <span className="muted">{r.offer.store} · {formatDateTime(r.created_at)}</span>
                  </div>
                  <div className="muted" style={{ fontSize: 13 }}>
                    {r.offer.categories.map(categoryName).join("، ")} · {r.offer.audiences.map((a) => AUDIENCE_LABEL_AR[a] ?? a).join(" / ")}
                    {r.offer.canonical_product_id ? " · مطابق لمنتج مرجعي" : ""}
                  </div>
                  <p style={{ whiteSpace: "pre-line", overflowWrap: "anywhere" }}>{r.message}</p>

                  {r.status === "PENDING" ? (
                    <>
                      <div className="field">
                        <label htmlFor={`guide-${r.id}`}>الدليل المنشور الذي يلبّي الطلب</label>
                        <select id={`guide-${r.id}`} value={c.guide_id} onChange={(e) => setChoice({ ...choice, [r.id]: { ...c, guide_id: e.target.value } })}>
                          <option value="">— اختاري —</option>
                          {options.map((g) => (
                            <option key={g.id} value={g.id}>
                              {g.name_ar} ({g.kind === "PRODUCT" ? "دليل المنتج" : "قياسي"})
                            </option>
                          ))}
                        </select>
                        {options.length === 0 && (
                          <span className="muted" style={{ fontSize: 13 }}>
                            لا يوجد دليل منشور ينطبق. أنشئي الدليل من <Link href="/admin/size-guides">أدلة المقاسات</Link> وانشريه ثم عودي.
                          </span>
                        )}
                      </div>
                      <div className="field">
                        <label htmlFor={`note-${r.id}`}>ملاحظة للمالك (إلزامية عند الرفض)</label>
                        <textarea id={`note-${r.id}`} rows={2} maxLength={1000} value={c.note} onChange={(e) => setChoice({ ...choice, [r.id]: { ...c, note: e.target.value } })} />
                      </div>
                      <div style={{ display: "flex", gap: 8 }}>
                        <button className="button button-secondary" disabled={busyId === r.id} onClick={() => void decide(r, "REJECTED")}>رفض</button>
                        <button className="button" disabled={busyId === r.id} onClick={() => void decide(r, "RESOLVED")}>ربط الدليل وإغلاق الطلب</button>
                      </div>
                    </>
                  ) : (
                    <p className="muted">
                      {STATUS_LABEL[r.status]}
                      {r.resolved_guide && ` - ${r.resolved_guide.name_ar}`}
                      {r.decision_note && ` - ${r.decision_note}`}
                      {r.decided_at && ` (${formatDateTime(r.decided_at)})`}
                    </p>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
