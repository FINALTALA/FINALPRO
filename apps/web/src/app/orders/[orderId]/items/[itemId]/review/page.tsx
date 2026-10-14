"use client";

import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useState } from "react";
import { ErrorBanner } from "@/components/States";
import { apiFetch, newIdempotencyKey } from "@/lib/api";
import { useHydrated, useSessionToken } from "@/lib/useSession";
import { reviewErrorMessage } from "@/lib/reviews";

interface ReviewDto {
  id: string;
  target_type: "PRODUCT" | "STORE";
}

// Sprint 23 (PDR-032, EPIC-REV): the customer's "كتابة مراجعة" form for
// one specific completed order item - mirrors the established return-
// request page's own convention exactly: eligibility is decided
// entirely server-side (ReviewsService.submit()'s full purchase/
// target-derivation walk), this page only shows whatever error comes
// back rather than duplicating that logic client-side.
export default function WriteReviewPage() {
  const params = useParams<{ orderId: string; itemId: string }>();
  const router = useRouter();
  const hydrated = useHydrated();
  const token = useSessionToken();

  const [targetType, setTargetType] = useState<"PRODUCT" | "STORE">("STORE");
  const [rating, setRating] = useState(5);
  const [body, setBody] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [created, setCreated] = useState<ReviewDto | null>(null);

  if (!hydrated) {
    return (
      <div className="page-shell">
        <div className="skeleton" style={{ height: 200, width: "100%", maxWidth: 560 }} />
      </div>
    );
  }
  if (!token) {
    router.replace(
      `/login?next=/orders/${params.orderId}/items/${params.itemId}/review`,
    );
    return null;
  }

  async function submit() {
    if (body.trim().length === 0) {
      setError("يرجى كتابة نص المراجعة");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const result = await apiFetch<ReviewDto>("/reviews", {
        method: "POST",
        body: {
          source_branch_order_item_id: params.itemId,
          target_type: targetType,
          rating,
          body: body.trim(),
        },
        idempotencyKey: newIdempotencyKey("review-submit"),
      });
      setCreated(result);
    } catch (err) {
      setError(reviewErrorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  if (created) {
    return (
      <div className="page-shell">
        <div className="card" style={{ maxWidth: 560 }}>
          <div className="notice-banner" role="status">تم إرسال مراجعتكِ، شكراً لكِ.</div>
          <Link href="/orders" className="button" style={{ marginTop: 8 }}>
            طلباتي
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div className="page-shell">
      <div className="top-bar">
        <h1 className="page-title" style={{ margin: 0 }}>كتابة مراجعة</h1>
        <Link href="/orders" className="button-link">طلباتي</Link>
      </div>
      {error && <ErrorBanner message={error} />}
      <div className="card" style={{ maxWidth: 560 }}>
        <div className="field">
          <label>المراجعة عن</label>
          <select
            value={targetType}
            disabled={busy}
            onChange={(e) => setTargetType(e.target.value as "PRODUCT" | "STORE")}
          >
            <option value="STORE">المتجر</option>
            <option value="PRODUCT">المنتج</option>
          </select>
        </div>
        <div className="field">
          <label>التقييم</label>
          <select
            value={rating}
            disabled={busy}
            onChange={(e) => setRating(Number(e.target.value))}
          >
            {[5, 4, 3, 2, 1].map((n) => (
              <option key={n} value={n}>
                {n} / 5
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label>التعليق</label>
          <textarea
            value={body}
            disabled={busy}
            onChange={(e) => setBody(e.target.value)}
            rows={4}
            maxLength={1000}
          />
        </div>
        <button className="button" disabled={busy} onClick={() => void submit()}>
          {busy ? "جارٍ الإرسال..." : "إرسال المراجعة"}
        </button>
      </div>
    </div>
  );
}
