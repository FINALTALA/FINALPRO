"use client";

import { useEffect, useState } from "react";
import { ErrorBanner } from "@/components/States";
import { apiFetch, ApiError, newIdempotencyKey } from "@/lib/api";

const MAX_MINUTES = 2880;

/** "90 دقيقة" / "3 ساعات" / "يومان" - how the owner reads a lead time. */
export function leadTimeLabel(minutes: number): string {
  if (minutes === 0) return "بلا وقت تجهيز";
  if (minutes % 1440 === 0) return minutes === 1440 ? "يوم واحد" : minutes === 2880 ? "يومان" : `${minutes / 1440} أيام`;
  if (minutes % 60 === 0) {
    const h = minutes / 60;
    return h === 1 ? "ساعة واحدة" : h === 2 ? "ساعتان" : h <= 10 ? `${h} ساعات` : `${h} ساعة`;
  }
  return `${minutes} دقيقة`;
}

/**
 * PD-5.1: a branch's preparation time before a delivery window. A
 * window closer than this is not offered to customers (product page,
 * comparison, cart, checkout) and can't be booked. The owner edits it;
 * an employee sees it read-only (the API refuses their writes anyway).
 */
export default function DeliveryLeadTimeCard({
  vendorId,
  branchId,
  canEdit,
}: {
  vendorId: string;
  branchId: string;
  canEdit: boolean;
}) {
  const path = `/vendors/${vendorId}/branches/${branchId}/delivery-lead-time`;
  const [saved, setSaved] = useState<number | null>(null);
  const [value, setValue] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    apiFetch<{ delivery_lead_minutes: number }>(path)
      .then((r) => {
        setSaved(r.delivery_lead_minutes);
        setValue(String(r.delivery_lead_minutes));
      })
      .catch((err) => setError(err instanceof ApiError ? err.message : "تعذّر تحميل وقت التجهيز"));
  }, [path]);

  const parsed = /^\d+$/.test(value.trim()) ? Number(value.trim()) : NaN;
  const valid = Number.isInteger(parsed) && parsed >= 0 && parsed <= MAX_MINUTES;

  async function save() {
    if (!valid) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const r = await apiFetch<{ delivery_lead_minutes: number }>(path, {
        method: "PUT",
        body: { delivery_lead_minutes: parsed },
        idempotencyKey: newIdempotencyKey("delivery-lead-time"),
      });
      setSaved(r.delivery_lead_minutes);
      setValue(String(r.delivery_lead_minutes));
      setNotice("تم حفظ وقت التجهيز");
    } catch (err) {
      setError(
        err instanceof ApiError && err.code === "VENDOR_SUSPENDED"
          ? "المتجر موقوف حالياً - لا يمكن تعديل وقت التجهيز"
          : err instanceof ApiError
            ? err.message
            : "تعذّر حفظ وقت التجهيز",
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="card delivery-lead-card" style={{ maxWidth: 640 }}>
      <div style={{ fontWeight: 600, marginBottom: 6 }}>وقت التجهيز قبل نافذة التوصيل</div>
      <p className="muted" style={{ marginTop: 0 }}>
        لا تُعرض للعملاء ولا تُحجز أي نافذة يبدأ موعدها قبل مرور هذا الوقت. النوافذ التي بدأت لا تُعرض أبداً.
      </p>
      {error && <ErrorBanner message={error} />}
      {saved === null && !error ? (
        <p className="muted">جارٍ التحميل...</p>
      ) : saved !== null && !canEdit ? (
        <p>
          <strong>{leadTimeLabel(saved)}</strong>
          <span className="muted"> · يعدّله صاحب المتجر فقط</span>
        </p>
      ) : saved !== null ? (
        <>
          <div className="field">
            <label htmlFor="delivery-lead-minutes">بالدقائق (من 0 إلى {MAX_MINUTES})</label>
            <input
              id="delivery-lead-minutes"
              inputMode="numeric"
              value={value}
              onChange={(e) => setValue(e.target.value)}
              aria-invalid={!valid}
              aria-describedby="delivery-lead-help"
              disabled={busy}
            />
            <span id="delivery-lead-help" className="muted" style={{ fontSize: ".82rem" }}>
              {valid ? leadTimeLabel(parsed) : `أدخلي رقماً صحيحاً من 0 إلى ${MAX_MINUTES}`}
            </span>
          </div>
          <button type="button" className="button" onClick={save} disabled={busy || !valid || parsed === saved}>
            حفظ وقت التجهيز
          </button>
          {notice && <p className="muted" role="status">{notice}</p>}
        </>
      ) : null}
    </div>
  );
}
