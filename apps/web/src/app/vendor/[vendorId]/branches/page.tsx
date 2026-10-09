"use client";

import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { EmptyState, ErrorBanner } from "@/components/States";
import { ApiError, apiFetch, newIdempotencyKey } from "@/lib/api";
import { useHydrated, useSessionToken, useWorkspaces } from "@/lib/useSession";

interface BranchDto {
  id: string;
  name: string;
  is_physical: boolean;
  verification_status: string;
  archived_at: string | null;
}

const VERIFICATION_LABEL: Record<string, string> = {
  PENDING: "قيد المراجعة",
  APPROVED: "معتمد",
  REJECTED: "مرفوض",
  RESUBMISSION_REQUESTED: "مطلوب إعادة إرسال",
};

// Sprint 13: the branches list, linking each branch to its own orders
// and delivery windows. GET /vendors/:vendorId/branches returns every
// branch to an owner and only the employee's own branch to an employee
// (server-side); creation/verification/staff invites stay API-only.
//
// Sprint 18b (G-ON-07): adding a branch (owner-only, requires the
// vendor itself ACTIVE) and archiving one (owner-only, the backend's
// own four rejection checks surface here as the plain error message -
// no client-side duplication of "does this branch have live orders"
// logic) plus a link to each branch's hours/closures page.
export default function BranchesPage() {
  const params = useParams<{ vendorId: string }>();
  const router = useRouter();
  const hydrated = useHydrated();
  const token = useSessionToken();
  const workspaces = useWorkspaces(token);
  const membership = workspaces?.find(
    (w) => w.type === "vendor" && w.vendor_id === params.vendorId,
  );
  const isOwner = membership?.type === "vendor" && membership.role === "OWNER";

  const [branches, setBranches] = useState<BranchDto[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [newBranchName, setNewBranchName] = useState("");
  const [adding, setAdding] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);

  function load() {
    apiFetch<BranchDto[]>(`/vendors/${params.vendorId}/branches`)
      .then((data) => {
        setError(null);
        setBranches(data);
      })
      .catch((err) => {
        setError(err instanceof ApiError ? err.message : "تعذّر تحميل الفروع");
      });
  }

  useEffect(() => {
    if (!hydrated) return;
    if (!token) {
      router.replace(`/login?next=/vendor/${params.vendorId}/branches`);
      return;
    }
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hydrated, token, params.vendorId]);

  async function addBranch() {
    if (!newBranchName.trim()) {
      setError("اسم الفرع مطلوب");
      return;
    }
    setAdding(true);
    setError(null);
    try {
      await apiFetch(`/vendors/${params.vendorId}/branches`, {
        method: "POST",
        body: { name: newBranchName.trim() },
        idempotencyKey: newIdempotencyKey("branch-add"),
      });
      setNewBranchName("");
      load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "تعذّر إضافة الفرع");
    } finally {
      setAdding(false);
    }
  }

  async function archiveBranch(branchId: string) {
    setBusyId(branchId);
    setError(null);
    try {
      await apiFetch(`/vendors/${params.vendorId}/branches/${branchId}/archive`, {
        method: "POST",
        body: {},
        idempotencyKey: newIdempotencyKey(`branch-archive-${branchId}`),
      });
      load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "تعذّر أرشفة الفرع");
    } finally {
      setBusyId(null);
    }
  }

  if (!hydrated || !token) {
    return (
      <div className="page-shell">
        <div className="skeleton" style={{ height: 120, width: "100%", maxWidth: 1000 }} />
      </div>
    );
  }

  return (
    <div className="page-shell">
      <div className="top-bar">
        <h1 className="page-title" style={{ margin: 0 }}>الفروع</h1>
        <Link href={`/vendor/${params.vendorId}`} className="button-link">لوحة المتجر</Link>
      </div>
      {error && <ErrorBanner message={error} />}

      {isOwner && (
        <div className="card" style={{ marginBottom: 16 }}>
          <div className="field" style={{ margin: 0 }}>
            <label>إضافة فرع جديد</label>
            <div style={{ display: "flex", gap: 8 }}>
              <input value={newBranchName} onChange={(e) => setNewBranchName(e.target.value)} />
              <button className="button" disabled={adding} onClick={addBranch}>
                إضافة
              </button>
            </div>
          </div>
        </div>
      )}

      {!branches && !error && (
        <div className="skeleton" style={{ height: 120, width: "100%", maxWidth: 1000 }} />
      )}
      {branches && branches.length === 0 && <EmptyState title="لا توجد فروع" />}
      {branches && branches.length > 0 && (
        <div className="hub-grid">
          {branches.map((b) => (
            <div key={b.id} className="hub-tile">
              <strong>{b.name}</strong>
              <span>
                {b.is_physical ? "فرع فعلي" : "موقع تجهيز"} - {VERIFICATION_LABEL[b.verification_status] ?? b.verification_status}
                {b.archived_at && " - مؤرشف"}
              </span>
              <div style={{ display: "flex", gap: 8, marginTop: 10, flexWrap: "wrap" }}>
                <Link href={`/vendor/${params.vendorId}/branches/${b.id}/orders`} className="button-link">
                  طلبات الفرع
                </Link>
                <Link href={`/vendor/${params.vendorId}/branches/${b.id}/delivery-windows`} className="button-link">
                  نوافذ التوصيل
                </Link>
                <Link href={`/vendor/${params.vendorId}/branches/${b.id}/stock`} className="button-link">
                  المخزون
                </Link>
                <Link href={`/vendor/${params.vendorId}/branches/${b.id}/hours`} className="button-link">
                  الساعات والإغلاقات
                </Link>
                <Link href={`/vendor/${params.vendorId}/branches/${b.id}/minimum-order`} className="button-link">
                  الحد الأدنى للطلب
                </Link>
                <Link href={`/vendor/${params.vendorId}/branches/${b.id}/returns`} className="button-link">
                  طلبات الإرجاع
                </Link>
                {isOwner && !b.archived_at && (
                  <button
                    className="button-link"
                    disabled={busyId === b.id}
                    onClick={() => archiveBranch(b.id)}
                  >
                    أرشفة
                  </button>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
