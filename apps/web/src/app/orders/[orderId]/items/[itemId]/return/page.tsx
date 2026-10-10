"use client";

import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useState } from "react";
import { ErrorBanner } from "@/components/States";
import { apiFetch, newIdempotencyKey } from "@/lib/api";
import { useHydrated, useSessionToken } from "@/lib/useSession";
import { RETURN_REASON_LABEL, returnErrorMessage } from "@/lib/returns";

interface ReturnDto {
  id: string;
  status: string;
}

const REASONS = Object.keys(RETURN_REASON_LABEL) as Array<
  keyof typeof RETURN_REASON_LABEL
>;

// Sprint 21 (FR-RET-001, review-round point 1): the customer's "طلب
// إرجاع" form for one specific order item. Eligibility itself is
// decided entirely server-side (checkReturnEligibility) - this page
// shows whatever 409 comes back (NOT_ELIGIBLE_FOR_RETURN's
// reason_code, RETURN_ALREADY_EXISTS, ...) as a plain error state
// rather than duplicating that logic client-side.
export default function RequestReturnPage() {
  const params = useParams<{ orderId: string; itemId: string }>();
  const router = useRouter();
  const hydrated = useHydrated();
  const token = useSessionToken();

  const [reason, setReason] = useState<keyof typeof RETURN_REASON_LABEL>("DAMAGED");
  const [note, setNote] = useState("");
  const [photoUrlsRaw, setPhotoUrlsRaw] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [created, setCreated] = useState<ReturnDto | null>(null);

  if (!hydrated) {
    return (
      <div className="page-shell">
        <div className="skeleton" style={{ height: 200, width: "100%", maxWidth: 560 }} />
      </div>
    );
  }
  if (!token) {
    router.replace(
      `/login?next=/orders/${params.orderId}/items/${params.itemId}/return`,
    );
    return null;
  }

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      const photo_urls = photoUrlsRaw
        .split(",")
        .map((u) => u.trim())
        .filter(Boolean);
      const result = await apiFetch<ReturnDto>(
        `/customers/me/orders/${params.orderId}/items/${params.itemId}/returns`,
        {
          method: "POST",
          body: {
            reason,
            ...(note.trim() ? { reason_note: note.trim() } : {}),
            ...(photo_urls.length ? { photo_urls } : {}),
          },
          idempotencyKey: newIdempotencyKey("return-submit"),
        },
      );
      setCreated(result);
    } catch (err) {
      setError(returnErrorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  if (created) {
    return (
      <div className="page-shell">
        <div className="card" style={{ maxWidth: 560 }}>
          <div className="notice-banner" role="status">
            تم إرسال طلب الإرجاع. سيراجعه المتجر خلال 48 ساعة.
          </div>
          <Link href={`/returns/${created.id}`} className="button" style={{ marginTop: 8 }}>
            تتبّع طلب الإرجاع
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div className="page-shell">
      <div className="top-bar">
        <h1 className="page-title" style={{ margin: 0 }}>طلب إرجاع</h1>
        <Link href="/orders" className="button-link">طلباتي</Link>
      </div>
      {error && <ErrorBanner message={error} />}
      <div className="card" style={{ maxWidth: 560 }}>
        <div className="field">
          <label>سبب الإرجاع</label>
          <select
            value={reason}
            disabled={busy}
            onChange={(e) => setReason(e.target.value as keyof typeof RETURN_REASON_LABEL)}
          >
            {REASONS.map((r) => (
              <option key={r} value={r}>
                {RETURN_REASON_LABEL[r]}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label>ملاحظة (اختياري)</label>
          <textarea
            rows={3}
            value={note}
            disabled={busy}
            onChange={(e) => setNote(e.target.value)}
          />
        </div>
        <div className="field">
          <label>روابط صور (اختياري، مفصولة بفاصلة)</label>
          <input
            value={photoUrlsRaw}
            disabled={busy}
            onChange={(e) => setPhotoUrlsRaw(e.target.value)}
            placeholder="https://...,https://..."
          />
        </div>
        <button className="button" disabled={busy} onClick={submit}>
          {busy ? "جارٍ الإرسال..." : "إرسال طلب الإرجاع"}
        </button>
      </div>
    </div>
  );
}
