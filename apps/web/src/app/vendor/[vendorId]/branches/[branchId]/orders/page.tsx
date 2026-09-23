"use client";

import { useParams, useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { apiFetch, ApiError } from "@/lib/api";
import { clearSession, getSessionToken } from "@/lib/session";

// Sprint 10 (RB-ORD-004, PDR-009): a branch employee's view of this
// endpoint returns only the minimal fields RB-ORD-004 names (name,
// phone, pickup code) - the owner reaching this same route gets a
// wider DTO server-side (see BranchOrdersStaffController's own
// comment), so the extra fields here are optional and simply unused
// by this deliberately minimal page rather than assumed present.
//
// Codex review round 4 on commit 95a8430 (fix #3): `id` itself is also
// owner-only now - the employee DTO carries only name/phone/pickup
// code, never an internal identifier just for a React list key (see
// the list's own key expression below, which never assumes `id` is
// present).
interface OrderRow {
  id?: string;
  customer_name: string | null;
  customer_phone: string;
  pickup_code: string | null;
  status?: string;
  fulfilment_method?: string;
  payment_method?: string;
  total?: number;
}

const STATUS_LABELS: Record<string, string> = {
  PLACED: "قيد الانتظار",
  PREPARING: "قيد التجهيز",
  SENT: "أُرسل",
  DELIVERED: "تم التوصيل",
  PICKED_UP: "تم الاستلام",
  COMPLETED: "مكتمل",
  CANCELLED: "ملغى",
  REFUNDED: "مسترد",
};

// A branch employee's read-only view of their OWN branch's orders
// only - VendorMembershipGuard itself refuses this route server-side
// if the employee's own assigned branch doesn't match :branchId, the
// same guard behavior every other per-branch page in this codebase
// already relies on. Deliberately NOT the full Orders UI - see
// VendorOrdersPage's own comment.
export default function BranchOrdersPage() {
  const params = useParams<{ vendorId: string; branchId: string }>();
  const router = useRouter();
  const [orders, setOrders] = useState<OrderRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!getSessionToken()) {
      router.replace("/login");
      return;
    }
    apiFetch<OrderRow[]>(
      `/vendors/${params.vendorId}/branches/${params.branchId}/orders`,
    )
      .then(setOrders)
      .catch((err) => {
        if (err instanceof ApiError && err.status === 401) {
          clearSession();
          router.replace("/login");
          return;
        }
        setError(err instanceof ApiError ? err.message : "تعذّر تحميل الطلبات");
      });
  }, [params.vendorId, params.branchId, router]);

  if (error) {
    return (
      <div className="page-shell">
        <div className="error-banner" style={{ maxWidth: 720 }}>{error}</div>
      </div>
    );
  }

  if (!orders) {
    return (
      <div className="page-shell">
        <p className="muted">جارٍ التحميل...</p>
      </div>
    );
  }

  return (
    <div className="page-shell">
      <div className="top-bar">
        <div className="brand" style={{ margin: 0 }}>طلبات الفرع</div>
      </div>

      {orders.length === 0 && <p className="muted">لا توجد طلبات بعد.</p>}

      <div style={{ maxWidth: 720, width: "100%", display: "flex", flexDirection: "column", gap: 10 }}>
        {orders.map((o, idx) => (
          <div key={o.id ?? `${idx}-${o.customer_phone}-${o.pickup_code ?? "none"}`} className="card">
            <div style={{ display: "flex", justifyContent: "space-between" }}>
              <span>{o.customer_name ?? "—"} — {o.customer_phone}</span>
              {o.status && <span className="muted">{STATUS_LABELS[o.status] ?? o.status}</span>}
            </div>
            {(o.fulfilment_method || o.payment_method || o.total !== undefined) && (
              <div className="muted">
                {o.fulfilment_method && (o.fulfilment_method === "PICKUP" ? "استلام من المحل" : "توصيل")}
                {o.payment_method && ` · ${o.payment_method === "ONLINE" ? "دفع إلكتروني" : "دفع عند الاستلام"}`}
                {o.total !== undefined && ` · ${o.total} ₪`}
              </div>
            )}
            {o.pickup_code && (
              <div style={{ fontWeight: 600, marginTop: 4 }}>رمز الاستلام: {o.pickup_code}</div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
