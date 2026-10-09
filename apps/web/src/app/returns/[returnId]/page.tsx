"use client";

import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useState } from "react";
import { EmptyState, ErrorBanner } from "@/components/States";
import { apiFetch, newIdempotencyKey } from "@/lib/api";
import { useFetch } from "@/lib/useFetch";
import { useHydrated, useSessionToken } from "@/lib/useSession";
import {
  RETURN_REASON_LABEL,
  RETURN_STATUS_LABEL,
  formatDateTime,
  returnErrorMessage,
} from "@/lib/returns";

interface ReturnDto {
  id: string;
  status: string;
  reason: string;
  reason_note: string | null;
  photo_urls: string[];
  code: string | null;
  code_expires_at: string | null;
  rejected_at: string | null;
  dispute_deadline_at: string | null;
  rejection_reason: string | null;
  escalated_at: string | null;
  received_at: string | null;
  item_condition: string | null;
  created_at: string;
}

// Sprint 21 (FR-RET-002/003, review-round point 1): a single return's
// full detail + the customer's own actions on it (cancel while
// REQUESTED, dispute while REJECTED and within the window) - every
// status in RETURN_STATUS_LABEL is a possible terminal/transient read
// here, so the page shows the raw status badge even for ones with no
// action available (RECEIVED/REFUND_PROCESSING/REFUNDED/ESCALATED/...).
export default function ReturnDetailPage() {
  const params = useParams<{ returnId: string }>();
  const router = useRouter();
  const hydrated = useHydrated();
  const token = useSessionToken();
  const [nonce, setNonce] = useState(0);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  const path =
    hydrated && token ? `/customers/me/returns/${params.returnId}?r=${nonce}` : null;
  const { data, error, status, loading } = useFetch<ReturnDto>(path, true);

  if (!hydrated) {
    return (
      <div className="page-shell">
        <div className="skeleton" style={{ height: 160, width: "100%", maxWidth: 560 }} />
      </div>
    );
  }
  if (!token) {
    router.replace(`/login?next=/returns/${params.returnId}`);
    return null;
  }

  async function cancel() {
    setBusy(true);
    setActionError(null);
    try {
      await apiFetch(`/customers/me/returns/${params.returnId}/cancel`, {
        method: "POST",
        idempotencyKey: newIdempotencyKey("return-cancel"),
      });
      setNonce((n) => n + 1);
    } catch (err) {
      setActionError(returnErrorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  async function dispute() {
    setBusy(true);
    setActionError(null);
    try {
      await apiFetch(`/customers/me/returns/${params.returnId}/dispute`, {
        method: "POST",
        idempotencyKey: newIdempotencyKey("return-dispute"),
      });
      setNonce((n) => n + 1);
    } catch (err) {
      setActionError(returnErrorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  if (loading) {
    return (
      <div className="page-shell">
        <div className="skeleton" style={{ height: 160, width: "100%", maxWidth: 560 }} />
      </div>
    );
  }
  if (status === 404) {
    return (
      <EmptyState
        title="لم يُعثر على طلب الإرجاع"
        actionHref="/returns"
        actionLabel="إرجاعاتي"
      />
    );
  }
  if (error || !data) {
    return (
      <div className="page-shell">
        <ErrorBanner message={error ?? "تعذّر تحميل طلب الإرجاع"} />
      </div>
    );
  }

  const canCancel = data.status === "REQUESTED";
  const canDispute =
    data.status === "REJECTED" &&
    !!data.dispute_deadline_at &&
    new Date(data.dispute_deadline_at) > new Date();

  return (
    <div className="page-shell">
      <div className="top-bar">
        <h1 className="page-title" style={{ margin: 0 }}>طلب إرجاع</h1>
        <Link href="/returns" className="button-link">إرجاعاتي</Link>
      </div>

      {actionError && <ErrorBanner message={actionError} />}

      <div className="card" style={{ maxWidth: 560 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
          <div style={{ fontWeight: 600 }}>{RETURN_REASON_LABEL[data.reason] ?? data.reason}</div>
          <span className="badge badge-active">{RETURN_STATUS_LABEL[data.status] ?? data.status}</span>
        </div>
        <div className="muted">قُدِّم في {formatDateTime(data.created_at)}</div>
        {data.reason_note && <div style={{ marginTop: 8 }}>ملاحظتك: {data.reason_note}</div>}

        {data.status === "APPROVED_AWAITING_DROPOFF" && data.code && (
          <div className="notice-banner" style={{ marginTop: 10 }}>
            كود الإرجاع: <strong>{data.code}</strong> - سلّمي المنتج لأي فرع من فروع المتجر وأعطيه هذا
            الكود. صالح حتى {formatDateTime(data.code_expires_at)}.
          </div>
        )}

        {data.status === "REJECTED" && (
          <div className="error-banner" style={{ marginTop: 10 }}>
            <div>سبب الرفض: {data.rejection_reason}</div>
            {canDispute && (
              <div className="muted" style={{ marginTop: 4 }}>
                يمكنك الاعتراض حتى {formatDateTime(data.dispute_deadline_at)}.
              </div>
            )}
          </div>
        )}

        {data.status === "ADMIN_REJECTED" && (
          <div className="error-banner" style={{ marginTop: 10 }}>
            قررت إدارة المنصة رفض هذا الطلب نهائياً: {data.rejection_reason}
          </div>
        )}

        {data.status === "ESCALATED" && (
          <div className="muted" style={{ marginTop: 10 }}>
            اعترضتِ على رفض المتجر، وطلب الإرجاع الآن بانتظار قرار إدارة المنصة.
          </div>
        )}

        {data.status === "RECEIVED" || data.status === "REFUND_PROCESSING" ? (
          <div className="muted" style={{ marginTop: 10 }}>
            تم استلام المنتج في {formatDateTime(data.received_at)}، وجارٍ معالجة الاسترداد.
          </div>
        ) : null}

        {data.status === "REFUNDED" && (
          <div className="notice-banner" style={{ marginTop: 10 }}>
            تم استرداد المبلغ.
          </div>
        )}

        {data.status === "EXPIRED" && (
          <div className="muted" style={{ marginTop: 10 }}>
            لم يُسلَّم المنتج خلال 7 أيام من اعتماد الطلب، فانتهت صلاحية الكود.
          </div>
        )}

        {canCancel && (
          <button className="button button-secondary" style={{ marginTop: 12 }} disabled={busy} onClick={cancel}>
            إلغاء طلب الإرجاع
          </button>
        )}
        {canDispute && (
          <button className="button" style={{ marginTop: 12 }} disabled={busy} onClick={dispute}>
            الاعتراض على الرفض
          </button>
        )}
      </div>
    </div>
  );
}
