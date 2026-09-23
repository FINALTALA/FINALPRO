"use client";

import { useParams, useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { apiFetch, ApiError } from "@/lib/api";
import { clearSession, getSessionToken } from "@/lib/session";

// Sprint 10 (RB-ORD-004, PDR-009): a branch employee's view of this
// endpoint returns a minimal DTO - the owner reaching this same route
// gets a wider DTO server-side (see BranchOrdersStaffController's own
// comment), so the extra fields here are optional and simply unused
// by this deliberately minimal page rather than assumed present.
//
// Sprint 11 (RB-FUL-002, PDR-009): id/status/fulfilment_method are now
// present for BOTH owner and employee - see employeeOrderDto's own
// comment for why: without them, a branch employee has no way to
// target or gate the fulfilment actions below on their own branch's
// orders. total/payment_method/created_at/address stay owner-only.
// Codex review on commit f940a80: the owner's own DTO carries the full
// not_received_reported_at timestamp (and, server-side, the reason -
// unused here); the employee's own DTO carries only the minimal
// has_open_not_received_report boolean instead (see employeeOrderDto's
// own comment). openReportFor() below reads whichever one is actually
// present so the same page works correctly for both roles without
// ever showing the employee a timestamp/reason they were never sent.
interface OrderRow {
  id: string;
  status: string;
  fulfilment_method: string;
  customer_name: string | null;
  customer_phone: string;
  pickup_code: string | null;
  payment_method?: string;
  total?: number;
  not_received_reported_at?: string | null;
  has_open_not_received_report?: boolean;
}

function openReportFor(o: OrderRow): boolean {
  return o.has_open_not_received_report ?? !!o.not_received_reported_at;
}

const STATUS_LABELS: Record<string, string> = {
  PLACED: "قيد الانتظار",
  PREPARING: "قيد التجهيز",
  SENT: "أُرسل",
  DELIVERED: "تم التوصيل - بانتظار تأكيد العميل",
  PICKED_UP: "تم الاستلام",
  COMPLETED: "مكتمل",
  CANCELLED: "ملغى",
  REFUNDED: "مسترد",
};

// A branch employee's view of their OWN branch's orders only -
// VendorMembershipGuard itself refuses this route server-side if the
// employee's own assigned branch doesn't match :branchId, the same
// guard behavior every other per-branch page in this codebase already
// relies on. An OWNER reaching this same route may act on any of
// their own vendor's branches too (RequireVendorRole isn't applied to
// these action endpoints - PDR-009 gives the owner authority over
// every one of their own branches, not just their own membership
// branch).
//
// Sprint 11 (RB-FUL-002/RB-ORD-004): now the real fulfilment-action
// surface - start preparation, mark sent, mark delivered, complete a
// pickup handover, and re-request confirmation after resolving a "not
// received" report externally. Deliberately NOT the full Orders UI
// (no per-item detail, no price breakdown for the employee) - that's
// the customer's own /orders page.
export default function BranchOrdersPage() {
  const params = useParams<{ vendorId: string; branchId: string }>();
  const router = useRouter();
  const [orders, setOrders] = useState<OrderRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [pickupCodeDrafts, setPickupCodeDrafts] = useState<Record<string, string>>({});

  function load() {
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
  }

  useEffect(() => {
    if (!getSessionToken()) {
      router.replace("/login");
      return;
    }
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [params.vendorId, params.branchId, router]);

  async function runAction(orderId: string, action: string, body?: Record<string, unknown>) {
    setBusyId(orderId);
    setError(null);
    try {
      await apiFetch(
        `/vendors/${params.vendorId}/branches/${params.branchId}/orders/${orderId}/${action}`,
        { method: "POST", body: body ?? {} },
      );
      load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "تعذّر تنفيذ الإجراء");
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
        <div className="brand" style={{ margin: 0 }}>طلبات الفرع</div>
      </div>

      {error && <div className="error-banner" style={{ maxWidth: 720 }}>{error}</div>}
      {orders.length === 0 && <p className="muted">لا توجد طلبات بعد.</p>}

      <div style={{ maxWidth: 720, width: "100%", display: "flex", flexDirection: "column", gap: 10 }}>
        {orders.map((o) => (
          <div key={o.id} className="card">
            <div style={{ display: "flex", justifyContent: "space-between" }}>
              <span>{o.customer_name ?? "—"} — {o.customer_phone}</span>
              <span className="muted">{STATUS_LABELS[o.status] ?? o.status}</span>
            </div>
            <div className="muted">
              {o.fulfilment_method === "PICKUP" ? "استلام من المحل" : "توصيل"}
              {o.payment_method && ` · ${o.payment_method === "ONLINE" ? "دفع إلكتروني" : "دفع عند الاستلام"}`}
              {o.total !== undefined && ` · ${o.total} ₪`}
            </div>
            {o.pickup_code && (
              <div style={{ fontWeight: 600, marginTop: 4 }}>رمز الاستلام: {o.pickup_code}</div>
            )}

            <div style={{ marginTop: 10, display: "flex", flexDirection: "column", gap: 8 }}>
              {o.status === "PLACED" && (
                <button
                  className="button"
                  disabled={busyId === o.id}
                  onClick={() => runAction(o.id, "start-preparation")}
                >
                  بدء التجهيز
                </button>
              )}

              {o.status === "PREPARING" && o.fulfilment_method === "DELIVERY" && (
                <button
                  className="button"
                  disabled={busyId === o.id}
                  onClick={() => runAction(o.id, "mark-sent")}
                >
                  تم الإرسال للناقل
                </button>
              )}

              {o.status === "SENT" && (
                <button
                  className="button"
                  disabled={busyId === o.id}
                  onClick={() => runAction(o.id, "mark-delivered")}
                >
                  تم التوصيل
                </button>
              )}

              {o.status === "PREPARING" && o.fulfilment_method === "PICKUP" && (
                <div style={{ display: "flex", gap: 8 }}>
                  <input
                    placeholder="رمز الاستلام من العميل"
                    style={{ flex: 1 }}
                    value={pickupCodeDrafts[o.id] ?? ""}
                    onChange={(e) =>
                      setPickupCodeDrafts((prev) => ({ ...prev, [o.id]: e.target.value }))
                    }
                  />
                  <button
                    className="button"
                    disabled={busyId === o.id}
                    onClick={() =>
                      runAction(o.id, "pickup-handover", {
                        pickup_code: pickupCodeDrafts[o.id] ?? "",
                      })
                    }
                  >
                    تسليم الطلب
                  </button>
                </div>
              )}

              {o.status === "DELIVERED" && openReportFor(o) && (
                <button
                  className="button-link"
                  disabled={busyId === o.id}
                  onClick={() => runAction(o.id, "rerequest-confirmation")}
                >
                  إعادة طلب تأكيد الاستلام (بعد حل المشكلة مع العميل)
                </button>
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
