"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { apiFetch, ApiError } from "@/lib/api";
import { clearSession, getSessionToken } from "@/lib/session";

interface OrderItem {
  offer_variant_id: string;
  title_ar: string;
  title_en: string;
  quantity: number;
  unit_price: number;
}

interface DeliveryWindowInfo {
  day_of_week: number;
  start_time: string;
  end_time: string;
}

interface AddressInfo {
  label: string | null;
  lat: number;
  lng: number;
  landmark_note: string | null;
  phone_number_1: string;
  phone_number_2: string | null;
  zone: string | null;
}

interface OrderDto {
  id: string;
  vendor_id: string;
  vendor_display_name: string;
  vendor_slug: string;
  branch_id: string;
  branch_name: string;
  status: string;
  fulfilment_method: string;
  payment_method: string;
  items: OrderItem[];
  subtotal: number;
  delivery_fee: number | null;
  total: number;
  scheduled_date: string | null;
  delivery_window: DeliveryWindowInfo | null;
  address: AddressInfo | null;
  pickup_code: string | null;
  delivered_at: string | null;
  not_received_reported_at: string | null;
  not_received_reason: string | null;
  confirm_reminder_sent_at: string | null;
  created_at: string;
}

const STATUS_LABELS: Record<string, string> = {
  PLACED: "قيد الانتظار",
  PREPARING: "قيد التجهيز",
  SENT: "أُرسل",
  DELIVERED: "تم التوصيل - بانتظار تأكيدك",
  PICKED_UP: "تم الاستلام",
  COMPLETED: "مكتمل",
  CANCELLED: "ملغى",
  REFUNDED: "مسترد",
};

const DAY_LABELS = ["الأحد", "الاثنين", "الثلاثاء", "الأربعاء", "الخميس", "الجمعة", "السبت"];

// Sprint 11 (RB-ORD-005, PDR-026, §3.4): the customer's own cross-store
// Orders experience - one card per BranchOrder, never merging two
// branches of the same store, exactly matching the API's own grouping
// (each row IS one BranchOrder already).
export default function OrdersPage() {
  const router = useRouter();
  const [orders, setOrders] = useState<OrderDto[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [reportDrafts, setReportDrafts] = useState<Record<string, string>>({});

  function load() {
    apiFetch<OrderDto[]>("/customers/me/orders")
      .then(setOrders)
      .catch((err) => {
        if (err instanceof ApiError && err.status === 401) {
          clearSession();
          router.replace("/login");
          return;
        }
        setError(err instanceof ApiError ? err.message : "تعذّر تحميل الطلبات");
      });
  }

  useEffect(() => {
    if (!getSessionToken()) {
      router.replace("/login");
      return;
    }
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [router]);

  async function confirmReceived(orderId: string) {
    setBusyId(orderId);
    setError(null);
    try {
      await apiFetch(`/customers/me/orders/${orderId}/confirm-received`, {
        method: "POST",
      });
      load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "تعذّر تأكيد الاستلام");
    } finally {
      setBusyId(null);
    }
  }

  async function reportNotReceived(orderId: string) {
    const reason = (reportDrafts[orderId] ?? "").trim();
    if (!reason) {
      setError("يرجى كتابة سبب عدم الاستلام");
      return;
    }
    setBusyId(orderId);
    setError(null);
    try {
      await apiFetch(`/customers/me/orders/${orderId}/report-not-received`, {
        method: "POST",
        body: { reason },
      });
      load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "تعذّر إرسال البلاغ");
    } finally {
      setBusyId(null);
    }
  }

  if (error && !orders) {
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
        <div className="brand" style={{ margin: 0 }}>طلباتي</div>
      </div>

      {error && <div className="error-banner" style={{ maxWidth: 720 }}>{error}</div>}
      {orders.length === 0 && <p className="muted">لا توجد طلبات بعد.</p>}

      <div style={{ maxWidth: 720, width: "100%", display: "flex", flexDirection: "column", gap: 14 }}>
        {orders.map((o) => {
          const awaitingConfirm =
            o.status === "DELIVERED" && o.fulfilment_method === "DELIVERY";
          const hasOpenReport = !!o.not_received_reported_at;
          return (
            <div key={o.id} className="card">
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
                <div>
                  <div style={{ fontWeight: 600 }}>{o.vendor_display_name}</div>
                  <div className="muted">فرع: {o.branch_name}</div>
                </div>
                <span className="badge badge-active">{STATUS_LABELS[o.status] ?? o.status}</span>
              </div>

              <div style={{ marginTop: 10 }}>
                {o.items.map((it) => (
                  <div key={it.offer_variant_id} className="muted">
                    {it.title_ar} × {it.quantity} — {it.unit_price} ₪
                  </div>
                ))}
              </div>

              <div className="muted" style={{ marginTop: 8 }}>
                {o.fulfilment_method === "PICKUP" ? "استلام من المحل" : "توصيل"}
                {" · "}
                {o.payment_method === "ONLINE" ? "دفع إلكتروني" : "دفع عند الاستلام"}
              </div>

              {o.delivery_window && o.scheduled_date && (
                <div className="muted">
                  موعد التوصيل: {DAY_LABELS[o.delivery_window.day_of_week]} {o.scheduled_date} من{" "}
                  {o.delivery_window.start_time} إلى {o.delivery_window.end_time}
                </div>
              )}

              {o.address && (
                <div className="muted">
                  عنوان التوصيل: {o.address.label ?? "بدون تسمية"}
                  {o.address.landmark_note ? ` — ${o.address.landmark_note}` : ""}
                </div>
              )}

              {o.pickup_code && (
                <div style={{ fontWeight: 600, marginTop: 6 }}>رمز الاستلام: {o.pickup_code}</div>
              )}

              <div style={{ display: "flex", justifyContent: "space-between", marginTop: 10 }}>
                <span className="muted">
                  المجموع الفرعي {o.subtotal} ₪
                  {o.delivery_fee !== null ? ` + رسوم توصيل ${o.delivery_fee} ₪` : ""}
                </span>
                <span className="product-card-price">{o.total} ₪</span>
              </div>

              {awaitingConfirm && !hasOpenReport && (
                <div style={{ marginTop: 12, display: "flex", flexDirection: "column", gap: 8 }}>
                  <button
                    className="button"
                    disabled={busyId === o.id}
                    onClick={() => confirmReceived(o.id)}
                  >
                    تأكيد استلام الطلب
                  </button>
                  <div style={{ display: "flex", gap: 8 }}>
                    <input
                      placeholder="سبب عدم الاستلام"
                      style={{ flex: 1 }}
                      value={reportDrafts[o.id] ?? ""}
                      onChange={(e) =>
                        setReportDrafts((prev) => ({ ...prev, [o.id]: e.target.value }))
                      }
                    />
                    <button
                      className="button-link"
                      disabled={busyId === o.id}
                      onClick={() => reportNotReceived(o.id)}
                    >
                      لم يصلني الطلب
                    </button>
                  </div>
                </div>
              )}

              {hasOpenReport && (
                <div className="error-banner" style={{ marginTop: 12 }}>
                  <div>
                    تم إبلاغ المتجر بعدم استلام الطلب («{o.not_received_reason}»). لا يوجد
                    نظام شكاوى داخل المنصة - يرجى التواصل مع المتجر مباشرة لحل المشكلة.
                  </div>
                  <Link
                    href={`/store/${o.vendor_slug}`}
                    className="button"
                    style={{ display: "inline-block", marginTop: 8 }}
                  >
                    فتح صفحة المتجر والتواصل
                  </Link>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
