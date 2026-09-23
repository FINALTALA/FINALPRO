"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { EmptyState, ErrorBanner } from "@/components/States";
import { useFetch } from "@/lib/useFetch";

interface BranchDto {
  id: string;
  name: string;
  is_physical: boolean;
  verification_status: string;
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
export default function BranchesPage() {
  const params = useParams<{ vendorId: string }>();
  const branches = useFetch<BranchDto[]>(`/vendors/${params.vendorId}/branches`, true);

  return (
    <div className="page-shell">
      <div className="top-bar">
        <h1 className="page-title" style={{ margin: 0 }}>الفروع</h1>
        <Link href={`/vendor/${params.vendorId}`} className="button-link">لوحة المتجر</Link>
      </div>
      {branches.error && <ErrorBanner message={branches.error} />}
      {branches.loading && <div className="skeleton" style={{ height: 120, width: "100%", maxWidth: 1000 }} />}
      {branches.data && branches.data.length === 0 && <EmptyState title="لا توجد فروع" />}
      {branches.data && branches.data.length > 0 && (
        <div className="hub-grid">
          {branches.data.map((b) => (
            <div key={b.id} className="hub-tile">
              <strong>{b.name}</strong>
              <span>
                {b.is_physical ? "فرع فعلي" : "موقع تجهيز"} - {VERIFICATION_LABEL[b.verification_status] ?? b.verification_status}
              </span>
              <div style={{ display: "flex", gap: 8, marginTop: 10, flexWrap: "wrap" }}>
                <Link href={`/vendor/${params.vendorId}/branches/${b.id}/orders`} className="button-link">
                  طلبات الفرع
                </Link>
                <Link href={`/vendor/${params.vendorId}/branches/${b.id}/delivery-windows`} className="button-link">
                  نوافذ التوصيل
                </Link>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
