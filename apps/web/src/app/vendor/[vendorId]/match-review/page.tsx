"use client";

import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { EmptyState, ErrorBanner } from "@/components/States";
import { ApiError, apiFetch, newIdempotencyKey } from "@/lib/api";
import { useHydrated, useSessionToken, useWorkspaces } from "@/lib/useSession";

interface QueueCandidateDto {
  id: string;
  score: number;
  status: "PENDING" | "APPROVED" | "REJECTED";
  created_at: string;
  decided_at: string | null;
  offer_id: string;
  offer_variant_id: string;
  offer_title_ar: string;
  offer_title_en: string;
  variant_colour: string | null;
  variant_size: string | null;
  variant_seller_sku: string;
  canonical_variant_id: string;
  canonical_model_name: string;
  canonical_brand_name: string;
  canonical_structural_attributes: Record<string, unknown>;
}

interface QueuePageDto {
  items: QueueCandidateDto[];
  next_cursor: string | null;
}

// Review-round fix (owner matching UI): the non-exact match review
// queue (RB-MATCH-002) had a fully built, tested backend
// (MatchReviewController) since Sprint 6/7 but no UI at all - this is
// that UI. Owner-only in the UI; the API refuses anyone else
// (VendorMembershipGuard + @RequireVendorRole('OWNER') per method).
// Deterministic pagination (score DESC, createdAt ASC, id ASC keyset -
// see match-review.controller.ts's queue()) so a page reload never
// duplicates or drops a candidate on a score tie.
export default function MatchReviewQueuePage() {
  const params = useParams<{ vendorId: string }>();
  const router = useRouter();
  const hydrated = useHydrated();
  const token = useSessionToken();
  const workspaces = useWorkspaces(token);
  const membership = workspaces?.find(
    (w) => w.type === "vendor" && w.vendor_id === params.vendorId,
  );
  const isOwner = membership?.type === "vendor" && membership.role === "OWNER";

  const [items, setItems] = useState<QueueCandidateDto[] | null>(null);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [forbidden, setForbidden] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);

  function load(cursor?: string, append = false) {
    const qs = cursor ? `?cursor=${encodeURIComponent(cursor)}` : "";
    apiFetch<QueuePageDto>(`/vendors/${params.vendorId}/match-review/queue${qs}`)
      .then((page) => {
        setError(null);
        setItems((prev) => (append && prev ? [...prev, ...page.items] : page.items));
        setNextCursor(page.next_cursor);
      })
      .catch((err) => {
        if (err instanceof ApiError && err.status === 403) {
          setForbidden(true);
          return;
        }
        setError(err instanceof ApiError ? err.message : "تعذّر تحميل طابور المراجعة");
      })
      .finally(() => setLoadingMore(false));
  }

  useEffect(() => {
    if (!hydrated) return;
    if (!token) {
      router.replace(`/login?next=/vendor/${params.vendorId}/match-review`);
      return;
    }
    if (!isOwner) return;
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hydrated, token, isOwner, params.vendorId]);

  async function decide(candidate: QueueCandidateDto, decision: "approve" | "reject") {
    setBusyId(candidate.id);
    setError(null);
    try {
      await apiFetch(
        `/vendors/${params.vendorId}/offers/${candidate.offer_id}/variants/${candidate.offer_variant_id}/match-review/candidates/${candidate.id}/decision`,
        {
          method: "POST",
          body: { decision },
          idempotencyKey: newIdempotencyKey(`match-review-decision-${candidate.id}`),
        },
      );
      // Re-fetch from the server rather than removing the row locally -
      // the source of truth for "is this candidate still PENDING" is
      // the queue endpoint itself.
      setItems(null);
      setNextCursor(null);
      load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "تعذّر تنفيذ القرار");
    } finally {
      setBusyId(null);
    }
  }

  if (!hydrated || !token || workspaces === null) {
    return (
      <div className="page-shell">
        <div className="skeleton" style={{ height: 120, width: "100%", maxWidth: 1000 }} />
      </div>
    );
  }
  if (!isOwner || forbidden) {
    return (
      <div className="page-shell">
        <EmptyState title="هذه الصفحة لمالك المتجر فقط" actionHref="/account" actionLabel="حسابي" />
      </div>
    );
  }

  return (
    <div className="page-shell">
      <div className="wide-shell" style={{ maxWidth: 1000 }}>
        <div className="top-bar">
          <h1 className="page-title" style={{ margin: 0 }}>مراجعة التطابق</h1>
          <Link href={`/vendor/${params.vendorId}`} className="button-link">لوحة المتجر</Link>
        </div>
        {error && <ErrorBanner message={error} />}
        {!items && !error && (
          <div className="skeleton" style={{ height: 120, width: "100%", maxWidth: 1000 }} />
        )}
        {items && items.length === 0 && (
          <EmptyState
            title="لا توجد مرشّحات مطابقة بانتظار المراجعة"
            message="سيظهر هنا كل مرشّح تطابق غير دقيق لأحد متغيّرات عروضك، لتؤكديه أو ترفضيه."
          />
        )}
        {items && items.length > 0 && (
          <>
            <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
              {items.map((c) => (
                <div key={c.id} className="card" style={{ padding: 16 }}>
                  <div className="top-bar" style={{ marginBottom: 8 }}>
                    <div>
                      <strong>{c.offer_title_ar}</strong>
                      <span className="muted" style={{ marginInlineStart: 8 }}>
                        {[c.variant_colour, c.variant_size].filter(Boolean).join(" / ") ||
                          c.variant_seller_sku}
                      </span>
                    </div>
                    <span className="badge">درجة التطابق: {(c.score * 100).toFixed(0)}٪</span>
                  </div>
                  <p className="muted" style={{ margin: "4px 0" }}>
                    مرشّح: {c.canonical_brand_name} — {c.canonical_model_name}
                  </p>
                  {Object.keys(c.canonical_structural_attributes ?? {}).length > 0 && (
                    <p className="muted" style={{ margin: "4px 0", fontSize: 13 }}>
                      {Object.entries(c.canonical_structural_attributes)
                        .map(([k, v]) => `${k}: ${v}`)
                        .join("، ")}
                    </p>
                  )}
                  <div style={{ display: "flex", gap: 8, marginTop: 12 }}>
                    <Link
                      href={`/vendor/${params.vendorId}/offers/${c.offer_id}/variants/${c.offer_variant_id}`}
                      className="button-link"
                    >
                      فتح المتغيّر
                    </Link>
                    <button
                      className="button"
                      disabled={busyId === c.id}
                      onClick={() => decide(c, "approve")}
                    >
                      تأكيد المطابقة
                    </button>
                    <button
                      className="button-link"
                      disabled={busyId === c.id}
                      onClick={() => decide(c, "reject")}
                    >
                      رفض
                    </button>
                  </div>
                </div>
              ))}
            </div>
            {nextCursor && (
              <div style={{ marginTop: 16 }}>
                <button
                  className="button-link"
                  disabled={loadingMore}
                  onClick={() => {
                    setLoadingMore(true);
                    load(nextCursor, true);
                  }}
                >
                  {loadingMore ? "جارٍ التحميل..." : "تحميل المزيد"}
                </button>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
