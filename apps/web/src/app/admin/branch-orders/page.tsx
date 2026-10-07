"use client";

import Link from "next/link";
import { useState } from "react";
import { ErrorBanner } from "@/components/States";
import { apiFetch, newIdempotencyKey } from "@/lib/api";
import { adminErrorMessage } from "@/lib/admin";
import { useAdminGate } from "@/lib/useAdminGate";

// Sprint 20a (BR-019): PLATFORM_ADMIN's two "break-glass" overrides on
// a BranchOrder - a forced cancel and a manual refund. There is no
// platform-wide branch-order search/list endpoint in this sprint's
// scope, so this page acts by id only (the id is read from the vendor/
// customer-facing support conversation, not browsed here).
export default function AdminBranchOrdersPage() {
  const gate = useAdminGate("ADMIN");
  const [branchOrderId, setBranchOrderId] = useState("");
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  async function run(action: "cancel" | "refund") {
    const id = branchOrderId.trim();
    const reasonText = reason.trim();
    if (!id) {
      setError("يرجى إدخال معرّف الطلب");
      return;
    }
    if (reasonText.length < 10) {
      setError("يلزم إدخال سبب (10 أحرف على الأقل)");
      return;
    }
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const result = await apiFetch<{ refunded_amount: number; order_closed?: boolean }>(
        `/admin/branch-orders/${id}/${action}`,
        {
          method: "POST",
          body: { reason: reasonText },
          idempotencyKey: newIdempotencyKey(`admin-branch-order-${action}`),
        },
      );
      setNotice(
        action === "cancel"
          ? `تم تنفيذ الإلغاء القسري. المبلغ المسترد: ${result.refunded_amount} ₪`
          : `تم تنفيذ الاسترداد اليدوي. المبلغ المسترد: ${result.refunded_amount} ₪`,
      );
    } catch (err) {
      setError(adminErrorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  if (gate.status === "loading") {
    return (
      <div className="page-shell">
        <div className="skeleton" style={{ height: 120, width: "100%", maxWidth: 720 }} />
      </div>
    );
  }
  if (gate.status === "forbidden") {
    return (
      <div className="page-shell">
        <ErrorBanner message="هذه الصفحة لمدير المنصة فقط." />
      </div>
    );
  }

  return (
    <div className="page-shell">
      <div className="wide-shell" style={{ maxWidth: 720 }}>
        <div className="top-bar">
          <h1 className="page-title" style={{ margin: 0 }}>إلغاء/استرداد قسري لطلب</h1>
          <Link href="/admin" className="button-link">إدارة المنصة</Link>
        </div>

        {error && <ErrorBanner message={error} />}
        {notice && <div className="notice-banner" role="status">{notice}</div>}

        <div className="card" style={{ maxWidth: "none" }}>
          <div className="field">
            <label htmlFor="branch-order-id">معرّف الطلب (BranchOrder id)</label>
            <input
              id="branch-order-id"
              value={branchOrderId}
              disabled={busy}
              onChange={(e) => setBranchOrderId(e.target.value)}
            />
          </div>
          <div className="field">
            <label htmlFor="reason">السبب (مطلوب، 10-1000 حرف)</label>
            <textarea
              id="reason"
              rows={3}
              value={reason}
              disabled={busy}
              onChange={(e) => setReason(e.target.value)}
            />
          </div>
          <p className="muted">
            الإلغاء القسري: يُغلق الطلب إن لم يكن في حالة نهائية - دفع عند الاستلام يُلغى بلا
            استرداد، والدفع الإلكتروني يُسترد بالكامل (المنتجات + رسوم التوصيل) ضمن نفس العملية.
          </p>
          <p className="muted">
            الاسترداد اليدوي: للطلبات الإلكترونية فقط، بحد أقصى هو المبلغ المتبقي القابل للاسترداد
            فعلياً - لا يقبل أي مبلغ يُدخل يدوياً.
          </p>
          <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
            <button className="button button-secondary" disabled={busy} onClick={() => run("cancel")}>
              إلغاء قسري
            </button>
            <button className="button" disabled={busy} onClick={() => run("refund")}>
              استرداد يدوي
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
