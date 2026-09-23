"use client";

import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { apiFetch, ApiError } from "@/lib/api";
import { clearSession, getSessionToken } from "@/lib/session";

interface BranchDto {
  id: string;
  vendor_id: string;
  name: string;
  is_physical: boolean;
  verification_status: string;
}

// Sprint 9 (RB-FUL-001): a delivery-window calendar belongs to one
// branch, not to the vendor as a whole (PDR-022/024) - this is just a
// branch picker in front of each branch's own calendar page.
export default function DeliveryWindowsBranchPickerPage() {
  const params = useParams<{ vendorId: string }>();
  const router = useRouter();
  const [branches, setBranches] = useState<BranchDto[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!getSessionToken()) {
      router.replace("/login");
      return;
    }
    apiFetch<BranchDto[]>(`/vendors/${params.vendorId}/branches`)
      .then(setBranches)
      .catch((err) => {
        if (err instanceof ApiError && err.status === 401) {
          clearSession();
          router.replace("/login");
          return;
        }
        setError(err instanceof ApiError ? err.message : "تعذّر تحميل الفروع");
      });
  }, [params.vendorId, router]);

  if (error && !branches) {
    return (
      <div className="page-shell">
        <div className="error-banner" style={{ maxWidth: 560 }}>{error}</div>
      </div>
    );
  }

  if (!branches) {
    return (
      <div className="page-shell">
        <p className="muted">جارٍ التحميل...</p>
      </div>
    );
  }

  return (
    <div className="page-shell">
      <div className="top-bar">
        <div className="brand" style={{ margin: 0 }}>
          تقويم مواعيد التوصيل
        </div>
        <Link href={`/vendor/${params.vendorId}`} className="button-link">
          لوحة المتجر
        </Link>
      </div>

      <p className="muted" style={{ maxWidth: 560 }}>
        اختاري فرعاً لإدارة نوافذ التوصيل الأسبوعية والاستثناءات الخاصة به.
        كل فرع له تقويمه المستقل.
      </p>

      <div style={{ maxWidth: 560, width: "100%", display: "flex", flexDirection: "column", gap: 12 }}>
        {branches.length === 0 && <p className="muted">لا توجد فروع بعد.</p>}
        {branches.map((branch) => (
          <Link
            key={branch.id}
            href={`/vendor/${params.vendorId}/branches/${branch.id}/delivery-windows`}
            className="card"
            style={{ display: "block", textDecoration: "none", color: "inherit" }}
          >
            <div style={{ fontWeight: 600 }}>{branch.name}</div>
            <div className="muted">
              {branch.is_physical ? "فرع فعلي" : "فرع غير فعلي"}
            </div>
          </Link>
        ))}
      </div>
    </div>
  );
}
