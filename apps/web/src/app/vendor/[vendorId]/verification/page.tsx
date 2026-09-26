"use client";

import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useEffect } from "react";
import { EmptyState, ErrorBanner } from "@/components/States";
import {
  STORE_TYPE_LABEL,
  SUSPENSION_REASON_LABEL,
  VENDOR_STATUS_LABEL,
  VERIFICATION_STATUS_LABEL,
  formatDateTime,
} from "@/lib/admin";
import { useFetch } from "@/lib/useFetch";
import { useHydrated, useSessionToken, useWorkspaces } from "@/lib/useSession";

interface StatusDto {
  vendor: { id: string; legal_name: string; store_type: string; status: string };
  branches: {
    id: string;
    name: string;
    status: string;
    evidence_submitted: boolean;
    submitted_at: string | null;
    reviewed_at: string | null;
    review_note: string | null;
  }[];
  warehouse: {
    status: string;
    submitted_at: string;
    reviewed_at: string | null;
    review_note: string | null;
  } | null;
  suspension: {
    reason_code: string;
    reason: string;
    suspended_at: string;
  } | null;
}

function ReviewNote({ status, note }: { status: string; note: string | null }) {
  if (!note || (status !== "REJECTED" && status !== "RESUBMISSION_REQUESTED")) return null;
  return (
    <div className="warning-banner" style={{ marginTop: 8 }}>
      <strong>ملاحظة المراجع:</strong> <span style={{ whiteSpace: "pre-wrap" }}>{note}</span>
    </div>
  );
}

// Sprint 16 (D7): the owner's view of their own verification outcome -
// status and the reviewer's reason. It never shows coordinates, photos or
// the warehouse address, and never who reviewed it. Owner only in the UI;
// the API refuses anyone else (VendorMembershipGuard + OWNER role).
export default function OwnerVerificationPage() {
  const params = useParams<{ vendorId: string }>();
  const router = useRouter();
  const hydrated = useHydrated();
  const token = useSessionToken();
  const workspaces = useWorkspaces(token);
  const membership = workspaces?.find(
    (w) => w.type === "vendor" && w.vendor_id === params.vendorId,
  );
  const isOwner = membership?.type === "vendor" && membership.role === "OWNER";
  const status = useFetch<StatusDto>(
    isOwner ? `/vendors/${params.vendorId}/verification-status` : null,
    true,
  );

  useEffect(() => {
    if (hydrated && !token) {
      router.replace(`/login?next=/vendor/${params.vendorId}/verification`);
    }
  }, [hydrated, token, params.vendorId, router]);

  if (!hydrated || !token || workspaces === null) {
    return (
      <div className="page-shell">
        <div className="skeleton" style={{ height: 120, width: "100%", maxWidth: 800 }} />
      </div>
    );
  }
  if (!isOwner || status.status === 403) {
    return (
      <div className="page-shell">
        <EmptyState
          title="هذه الصفحة لمالك المتجر فقط"
          actionHref="/account"
          actionLabel="حسابي"
        />
      </div>
    );
  }

  const d = status.data;
  return (
    <div className="page-shell">
      <div className="wide-shell" style={{ maxWidth: 800 }}>
        <div className="top-bar">
          <h1 className="page-title" style={{ margin: 0 }}>حالة التحقق</h1>
          <Link href={`/vendor/${params.vendorId}`} className="button-link">لوحة المتجر</Link>
        </div>

        {status.error && <ErrorBanner message={status.error} />}
        {status.loading && (
          <div aria-busy="true" aria-label="جارٍ التحميل">
            <div className="skeleton" style={{ height: 160, width: "100%" }} />
          </div>
        )}

        {d && (
          <>
            {d.suspension && (
              <div className="warning-banner" role="alert">
                <strong>المتجر معلَّق</strong> ({SUSPENSION_REASON_LABEL[d.suspension.reason_code] ?? d.suspension.reason_code}) منذ{" "}
                {formatDateTime(d.suspension.suspended_at)}.
                <div style={{ whiteSpace: "pre-wrap", marginTop: 6 }}>{d.suspension.reason}</div>
                <div className="muted" style={{ marginTop: 6 }}>
                  الطلبات الجارية تستمر بالتنفيذ، لكن المتجر مخفي ولا يقبل طلبات جديدة.
                </div>
              </div>
            )}

            <div className="card" style={{ maxWidth: "none", marginBottom: 14 }}>
              <h2 style={{ marginTop: 0 }}>{d.vendor.legal_name}</h2>
              <p>
                <span className={`badge${d.vendor.status === "ACTIVE" ? " badge-active" : ""}`}>
                  {VENDOR_STATUS_LABEL[d.vendor.status] ?? d.vendor.status}
                </span>{" "}
                <span className="muted">{STORE_TYPE_LABEL[d.vendor.store_type] ?? d.vendor.store_type}</span>
              </p>
              {d.vendor.status === "REJECTED" && (
                <p className="muted">
                  رُفض هذا الطلب نهائياً. يمكنك تقديم طلب جديد مصحَّح من حسابك.
                </p>
              )}
            </div>

            {d.branches.length > 0 && (
              <div className="card" style={{ maxWidth: "none", marginBottom: 14 }}>
                <h2 style={{ marginTop: 0 }}>الفروع</h2>
                {d.branches.map((b) => (
                  <div key={b.id} style={{ marginBottom: 14 }}>
                    <strong>{b.name}</strong>{" "}
                    <span className="badge">
                      {b.evidence_submitted
                        ? (VERIFICATION_STATUS_LABEL[b.status] ?? b.status)
                        : "لم يُقدَّم دليل بعد"}
                    </span>
                    {b.submitted_at && (
                      <div className="muted">آخر تقديم: {formatDateTime(b.submitted_at)}</div>
                    )}
                    <ReviewNote status={b.status} note={b.review_note} />
                    {b.status === "RESUBMISSION_REQUESTED" && (
                      <p className="muted">أعيدي إرسال الدليل بعد تصحيحه ليعود الفرع إلى المراجعة.</p>
                    )}
                  </div>
                ))}
              </div>
            )}

            {d.warehouse && (
              <div className="card" style={{ maxWidth: "none" }}>
                <h2 style={{ marginTop: 0 }}>عنوان المستودع</h2>
                <span className="badge">
                  {VERIFICATION_STATUS_LABEL[d.warehouse.status] ?? d.warehouse.status}
                </span>
                <div className="muted">آخر تقديم: {formatDateTime(d.warehouse.submitted_at)}</div>
                <ReviewNote status={d.warehouse.status} note={d.warehouse.review_note} />
                {d.warehouse.status === "RESUBMISSION_REQUESTED" && (
                  <p className="muted">صحّحي عنوان المستودع ثم أعيدي إرسال الدليل.</p>
                )}
              </div>
            )}

            {d.branches.length === 0 && !d.warehouse && (
              <EmptyState
                title="لا يوجد دليل تحقق مُقدَّم بعد"
                message="ستظهر هنا نتيجة المراجعة بعد تقديم دليل الفرع أو عنوان المستودع."
              />
            )}
          </>
        )}
      </div>
    </div>
  );
}
