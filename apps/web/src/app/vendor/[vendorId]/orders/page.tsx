"use client";

import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { apiFetch, ApiError } from "@/lib/api";
import { clearSession, getSessionToken } from "@/lib/session";

interface OrderRow {
  id: string;
  status: string;
  fulfilment_method: string;
  payment_method: string;
  total: number;
  created_at: string;
  customer_name: string | null;
  customer_phone: string;
  pickup_code: string | null;
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

// Sprint 10 (RB-ORD-004, PDR-009): the owner's read-only view of every
// order across ALL their branches - deliberately NOT the full Orders
// UI (no status-change actions, no Sent/Delivered workflow - that's
// Sprint 11). No customer address is shown here on any row, matching
// the backend's own response shape exactly.
export default function VendorOrdersPage() {
  const params = useParams<{ vendorId: string }>();
  const router = useRouter();
  const [orders, setOrders] = useState<OrderRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!getSessionToken()) {
      router.replace("/login");
      return;
    }
    apiFetch<OrderRow[]>(`/vendors/${params.vendorId}/orders`)
      .then(setOrders)
      .catch((err) => {
        if (err instanceof ApiError && err.status === 401) {
          clearSession();
          router.replace("/login");
          return;
        }
        setError(err instanceof ApiError ? err.message : "تعذّر تحميل الطلبات");
      });
  }, [params.vendorId, router]);

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
        <div className="brand" style={{ margin: 0 }}>طلبات جميع الفروع</div>
        <Link href={`/vendor/${params.vendorId}`} className="button-link">
          لوحة المتجر
        </Link>
      </div>

      {orders.length === 0 && <p className="muted">لا توجد طلبات بعد.</p>}

      <div style={{ maxWidth: 720, width: "100%", display: "flex", flexDirection: "column", gap: 10 }}>
        {orders.map((o) => (
          <div key={o.id} className="card">
            <div style={{ display: "flex", justifyContent: "space-between" }}>
              <span>{o.customer_name ?? "—"} — {o.customer_phone}</span>
              <span className="muted">{STATUS_LABELS[o.status] ?? o.status}</span>
            </div>
            <div className="muted">
              {o.fulfilment_method === "PICKUP" ? "استلام من المحل" : "توصيل"} ·{" "}
              {o.payment_method === "ONLINE" ? "دفع إلكتروني" : "دفع عند الاستلام"} · {o.total} ₪
            </div>
            {o.pickup_code && (
              <div style={{ fontWeight: 600, marginTop: 4 }}>رمز الاستلام: {o.pickup_code}</div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
