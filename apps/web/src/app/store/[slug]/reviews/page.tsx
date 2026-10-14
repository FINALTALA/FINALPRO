"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { useState } from "react";
import { ErrorBanner, SkeletonGrid } from "@/components/States";
import { apiFetch, newIdempotencyKey } from "@/lib/api";
import { useFetch } from "@/lib/useFetch";
import { useSessionToken } from "@/lib/useSession";
import { reviewErrorMessage } from "@/lib/reviews";

interface ReviewRow {
  id: string;
  target_type: "PRODUCT" | "STORE";
  rating: number;
  body: string;
  author: string;
  created_at: string;
}

interface ReviewsDto {
  aggregate: { average: number | null; count: number };
  reviews: ReviewRow[];
}

function formatDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "-";
  return d.toLocaleDateString("ar", { dateStyle: "medium" });
}

function ReportButton({ reviewId }: { reviewId: string }) {
  const token = useSessionToken();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  if (!token) return null;
  if (done) return <span className="muted">تم إرسال البلاغ</span>;

  if (!open) {
    return (
      <button className="button-link" onClick={() => setOpen(true)}>
        الإبلاغ عن هذه المراجعة
      </button>
    );
  }

  async function submit() {
    if (reason.trim().length === 0) {
      setError("يرجى كتابة سبب البلاغ");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await apiFetch(`/reviews/${reviewId}/report`, {
        method: "POST",
        body: { reason: reason.trim() },
        idempotencyKey: newIdempotencyKey("review-report"),
      });
      setDone(true);
    } catch (err) {
      setError(reviewErrorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={{ marginTop: 6 }}>
      {error && <ErrorBanner message={error} />}
      <textarea
        value={reason}
        disabled={busy}
        onChange={(e) => setReason(e.target.value)}
        rows={2}
        maxLength={1000}
        placeholder="سبب البلاغ"
      />
      <div style={{ display: "flex", gap: 8, marginTop: 4 }}>
        <button className="button button-secondary" disabled={busy} onClick={() => void submit()}>
          {busy ? "جارٍ الإرسال..." : "إرسال البلاغ"}
        </button>
        <button className="button-link" disabled={busy} onClick={() => setOpen(false)}>
          إلغاء
        </button>
      </div>
    </div>
  );
}

// Sprint 23 (PDR-032, EPIC-REV): the public, read-only reviews list for
// one store - its own self-contained page (not folded into the
// existing storefront page's design), linked from there additively.
export default function StoreReviewsPage() {
  const params = useParams<{ slug: string }>();
  const { data, error, loading } = useFetch<ReviewsDto>(`/storefronts/${params.slug}/reviews`);

  return (
    <div className="page-shell">
      <div className="top-bar">
        <h1 className="page-title" style={{ margin: 0 }}>مراجعات المتجر</h1>
        <Link href={`/store/${params.slug}`} className="button-link">رجوع للمتجر</Link>
      </div>
      {error && <ErrorBanner message={error} />}
      {loading && <SkeletonGrid count={3} />}

      {data && (
        <>
          <div className="card" style={{ maxWidth: 560 }}>
            {data.aggregate.average !== null ? (
              <p>
                التقييم العام: <strong>{data.aggregate.average} / 5</strong> ({data.aggregate.count} مراجعة)
              </p>
            ) : (
              <p className="muted">لا يوجد تقييم عام كافٍ بعد (يظهر عند 3 مراجعات أو أكثر).</p>
            )}
          </div>

          {data.reviews.length === 0 && <p className="muted" style={{ marginTop: 12 }}>لا توجد مراجعات بعد.</p>}

          <div style={{ display: "flex", flexDirection: "column", gap: 10, marginTop: 12 }}>
            {data.reviews.map((r) => (
              <div key={r.id} className="card" style={{ maxWidth: 560 }}>
                <div style={{ display: "flex", justifyContent: "space-between" }}>
                  <strong>{r.author}</strong>
                  <span>{r.rating} / 5</span>
                </div>
                <p style={{ marginTop: 6 }}>{r.body}</p>
                <div className="muted" style={{ fontSize: 13 }}>{formatDate(r.created_at)}</div>
                <ReportButton reviewId={r.id} />
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
