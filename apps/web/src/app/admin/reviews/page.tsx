"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { EmptyState, ErrorBanner } from "@/components/States";
import { apiFetch, authHeadersFor, newIdempotencyKey } from "@/lib/api";
import { adminErrorMessage, formatDateTime, isForbidden } from "@/lib/admin";
import { FIT_LABEL, purchasedLine, ReviewDto, TAG_LABEL } from "@/lib/reviews";
import { useAdminGate } from "@/lib/useAdminGate";

interface PendingReport {
  id: string;
  reason: string;
  media_id: string | null;
  created_at: string;
}

interface AdminMedia {
  id: string;
  url: string;
  alt_text: string | null;
  status: "VISIBLE" | "HIDDEN";
  hidden_reason: string | null;
}

interface ReportedReview extends Omit<ReviewDto, "media"> {
  media: AdminMedia[];
  revisions: { rating: number; body: string; revised_at: string }[];
  pending_reports: PendingReport[];
}

/**
 * The admin-only image route needs the session token, which an <img>
 * can't send - so the image is fetched with it and shown from a local
 * object URL (released when the card goes away).
 */
function AdminImage({ src, alt }: { src: string; alt: string }) {
  const [url, setUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let objectUrl: string | null = null;
    let cancelled = false;
    fetch(src, { headers: authHeadersFor(src) })
      .then((res) => (res.ok ? res.blob() : Promise.reject(new Error(String(res.status)))))
      .then((blob) => {
        if (cancelled) return;
        objectUrl = URL.createObjectURL(blob);
        setUrl(objectUrl);
      })
      .catch(() => !cancelled && setFailed(true));
    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [src]);
  if (failed) return <span className="admin-review-image is-missing">تعذّر تحميل الصورة</span>;
  // eslint-disable-next-line @next/next/no-img-element
  return url ? <img className="admin-review-image" src={url} alt={alt} /> : <span className="admin-review-image skeleton" />;
}

// Sprint 23 (PDR-032, EPIC-REV): the PLATFORM_ADMIN moderation queue -
// every review with at least one PENDING report, dismiss/uphold.
// Mirrors admin/verification/page.tsx's own useAdminGate convention.
// PD-3: the decision carries a reason (mandatory to hide - it is kept
// in the audit log and sent to the author), the review's images (hidden
// ones too) and earlier revisions are shown, and one image can be
// hidden on its own.
export default function AdminReviewsPage() {
  const gate = useAdminGate("ADMIN");
  const [items, setItems] = useState<ReportedReview[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [forbidden, setForbidden] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [reasons, setReasons] = useState<Record<string, string>>({});

  const load = useCallback(async () => {
    return apiFetch<ReportedReview[]>("/admin/reviews/reported");
  }, []);

  useEffect(() => {
    if (gate.status !== "ok") return;
    let cancelled = false;
    load()
      .then((rows) => {
        if (cancelled) return;
        setItems(rows);
        setError(null);
        setLoading(false);
      })
      .catch((err) => {
        if (cancelled) return;
        if (isForbidden(err)) setForbidden(true);
        setError(adminErrorMessage(err));
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [gate.status, load]);

  const reasonFor = (id: string) => (reasons[id] ?? "").trim();

  async function decide(reviewId: string, decision: "dismiss" | "uphold") {
    const reason = reasonFor(reviewId);
    if (decision === "uphold" && !reason) {
      setError("اكتبي سبب إخفاء المراجعة - يُحفظ في سجل التدقيق ويُرسل لكاتبها.");
      return;
    }
    setBusyId(reviewId);
    setError(null);
    try {
      await apiFetch(`/admin/reviews/${reviewId}/decision`, {
        method: "PATCH",
        body: { decision, ...(reason ? { reason } : {}) },
        idempotencyKey: newIdempotencyKey("review-decision"),
      });
      setItems((prev) => prev.filter((r) => r.id !== reviewId));
    } catch (err) {
      setError(adminErrorMessage(err));
    } finally {
      setBusyId(null);
    }
  }

  async function hideImage(reviewId: string, mediaId: string) {
    const reason = reasonFor(reviewId);
    if (!reason) {
      setError("اكتبي سبب إخفاء الصورة أولاً.");
      return;
    }
    setBusyId(reviewId);
    setError(null);
    try {
      await apiFetch(`/admin/reviews/${reviewId}/media/${mediaId}/hide`, {
        method: "PATCH",
        body: { reason },
        idempotencyKey: newIdempotencyKey("review-media-hide"),
      });
      setItems((prev) =>
        prev.map((r) =>
          r.id === reviewId
            ? { ...r, media: r.media.map((m) => (m.id === mediaId ? { ...m, status: "HIDDEN", hidden_reason: reason } : m)) }
            : r,
        ),
      );
    } catch (err) {
      setError(adminErrorMessage(err));
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
        <EmptyState title="هذه الصفحة لموظفي المنصة فقط" actionHref="/account" actionLabel="حسابي" />
      </div>
    );
  }

  return (
    <div className="page-shell">
      <div className="wide-shell" style={{ maxWidth: 1000 }}>
        <div className="top-bar">
          <h1 className="page-title" style={{ margin: 0 }}>بلاغات المراجعات</h1>
          <Link href="/admin" className="button-link">إدارة المنصة</Link>
        </div>

        {error && <ErrorBanner message={error} />}
        {loading && (
          <div aria-busy="true" aria-label="جارٍ التحميل">
            <div className="skeleton" style={{ height: 56, width: "100%", marginBottom: 8 }} />
            <div className="skeleton" style={{ height: 56, width: "100%" }} />
          </div>
        )}
        {!loading && !error && items.length === 0 && (
          <EmptyState title="لا توجد مراجعات عليها بلاغات معلَّقة" />
        )}
        {!loading && items.length > 0 && (
          <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
            {items.map((r) => {
              const bought = purchasedLine(r.purchased);
              return (
                <div key={r.id} className="card admin-review-card">
                  <div style={{ display: "flex", justifyContent: "space-between", gap: 12 }}>
                    <strong>{r.author}</strong>
                    <span>{r.rating} / 5 - {r.target_type === "PRODUCT" ? "منتج" : "متجر"}{r.store ? ` - ${r.store.name}` : ""}</span>
                  </div>
                  {(bought || r.fit || r.tags.length > 0 || r.edited) && (
                    <div className="muted" style={{ fontSize: 13, marginTop: 4 }}>
                      {[bought, r.fit ? `المقاس: ${FIT_LABEL[r.fit]}` : null, r.tags.map((t) => TAG_LABEL[t]).join("، ") || null, r.edited ? "معدّل" : null].filter(Boolean).join(" · ")}
                    </div>
                  )}
                  <p style={{ marginTop: 6 }}>{r.body}</p>
                  <div className="muted" style={{ fontSize: 13 }}>{formatDateTime(r.created_at)}</div>

                  {r.media.length > 0 && (
                    <div className="admin-review-media">
                      {r.media.map((m) => {
                        const reported = r.pending_reports.some((p) => p.media_id === m.id);
                        return (
                          <figure key={m.id} className={`${m.status === "HIDDEN" ? "is-hidden" : ""}${reported ? " is-reported" : ""}`}>
                            <AdminImage src={m.url} alt={m.alt_text ?? "صورة من المراجعة"} />
                            <figcaption>
                              {m.status === "HIDDEN" ? `مخفية: ${m.hidden_reason ?? ""}` : reported ? "عليها بلاغ" : "ظاهرة"}
                            </figcaption>
                            {m.status === "VISIBLE" && (
                              <button type="button" className="button-link" disabled={busyId === r.id} onClick={() => void hideImage(r.id, m.id)}>
                                إخفاء هذه الصورة فقط
                              </button>
                            )}
                          </figure>
                        );
                      })}
                    </div>
                  )}

                  {r.revisions.length > 0 && (
                    <details style={{ marginTop: 8 }}>
                      <summary className="muted">النسخ السابقة ({r.revisions.length})</summary>
                      <ul>
                        {r.revisions.map((v, i) => (
                          <li key={i}>{v.rating} / 5 - {v.body} <span className="muted">({formatDateTime(v.revised_at)})</span></li>
                        ))}
                      </ul>
                    </details>
                  )}

                  <div style={{ marginTop: 8 }}>
                    <div className="muted">البلاغات ({r.pending_reports.length}):</div>
                    <ul>
                      {r.pending_reports.map((p) => (
                        <li key={p.id}>
                          {p.reason}
                          {p.media_id && <span className="muted"> (عن صورة {r.media.findIndex((m) => m.id === p.media_id) + 1})</span>}
                          <span className="muted"> ({formatDateTime(p.created_at)})</span>
                        </li>
                      ))}
                    </ul>
                  </div>

                  <div className="field" style={{ marginTop: 8 }}>
                    <label htmlFor={`reason-${r.id}`}>سبب القرار (إلزامي للإخفاء)</label>
                    <textarea
                      id={`reason-${r.id}`}
                      rows={2}
                      maxLength={500}
                      value={reasons[r.id] ?? ""}
                      onChange={(e) => setReasons((all) => ({ ...all, [r.id]: e.target.value }))}
                      placeholder="يُحفظ في سجل التدقيق ويُرسل لكاتب المراجعة عند الإخفاء"
                    />
                  </div>

                  <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
                    <button
                      className="button button-secondary"
                      disabled={busyId === r.id}
                      onClick={() => void decide(r.id, "dismiss")}
                    >
                      تجاهل البلاغ
                    </button>
                    <button
                      className="button"
                      disabled={busyId === r.id}
                      onClick={() => void decide(r.id, "uphold")}
                    >
                      إخفاء المراجعة
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
