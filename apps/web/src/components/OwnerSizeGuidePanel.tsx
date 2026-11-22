"use client";

import { useEffect, useState } from "react";
import { ErrorBanner } from "@/components/States";
import { apiFetch, ApiError, newIdempotencyKey } from "@/lib/api";
import { formatMeasure, SizeGuideDto } from "@/lib/sizeGuides";

const AUDIENCE_LABEL: Record<string, string> = { WOMEN: "نساء", MEN: "رجال", KIDS: "أطفال" };
const REQUEST_STATUS_LABEL: Record<string, string> = {
  PENDING: "بانتظار مراجعة الإدارة",
  RESOLVED: "تمت الموافقة",
  REJECTED: "مرفوض",
};

interface OwnerSizeGuideView {
  offer_id: string;
  classified: boolean;
  size_guide_eligible: boolean;
  offer_sizes: string[];
  product_guide_applies: boolean;
  chosen_guide_id: string | null;
  options: {
    audience: string;
    guides: { id: string; code: string; name_ar: string; name_en: string; is_default: boolean }[];
  }[];
  guides: SizeGuideDto[];
  compatibility: { checked: boolean; mismatched_sizes: string[]; one_size_exempt: boolean };
  requests: {
    id: string;
    message: string;
    status: "PENDING" | "RESOLVED" | "REJECTED";
    decision_note: string | null;
    decided_at: string | null;
    created_at: string;
    resolved_guide: { id: string; code: string; name_ar: string } | null;
  }[];
}

/**
 * PD-4: the owner's size-guide card on the offer page. The owner only
 * picks among published guides the platform made for this category and
 * audience (decision 11) or asks the administrator for a custom one
 * (decision 2) - nothing here creates measurements. Employees get 403
 * from the API, so the card simply doesn't render for them.
 */
export default function OwnerSizeGuidePanel({ vendorId, offerId }: { vendorId: string; offerId: string }) {
  const [view, setView] = useState<OwnerSizeGuideView | null>(null);
  const [hidden, setHidden] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [preview, setPreview] = useState<string | null>(null);

  const base = `/vendors/${vendorId}/offers/${offerId}`;

  useEffect(() => {
    apiFetch<OwnerSizeGuideView>(`${base}/size-guide`)
      .then(setView)
      .catch((err) => {
        if (err instanceof ApiError && (err.status === 403 || err.status === 404)) setHidden(true);
        else setError(err instanceof ApiError ? err.message : "تعذّر تحميل دليل المقاسات");
      });
  }, [base]);

  async function choose(guideId: string | null) {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const next = await apiFetch<OwnerSizeGuideView>(`${base}/size-guide`, {
        method: "PUT",
        body: { size_guide_id: guideId },
        idempotencyKey: newIdempotencyKey("size-guide-choice"),
      });
      setView(next);
      setNotice(guideId ? "تم اختيار الدليل" : "عاد العرض إلى الدليل الافتراضي");
    } catch (err) {
      setError(err instanceof ApiError ? sizeGuideError(err) : "تعذّر حفظ الاختيار");
    } finally {
      setBusy(false);
    }
  }

  async function sendRequest() {
    if (!message.trim()) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await apiFetch(`${base}/size-guide-requests`, {
        method: "POST",
        body: { message: message.trim() },
        idempotencyKey: newIdempotencyKey("size-guide-request"),
      });
      setMessage("");
      setNotice("تم إرسال الطلب إلى الإدارة");
      setView(await apiFetch<OwnerSizeGuideView>(`${base}/size-guide`));
    } catch (err) {
      setError(err instanceof ApiError ? sizeGuideError(err) : "تعذّر إرسال الطلب");
    } finally {
      setBusy(false);
    }
  }

  if (hidden) return null;

  const pending = view?.requests.some((r) => r.status === "PENDING") ?? false;
  const selectable = view ? view.options.some((o) => o.guides.length > 0) : false;

  return (
    <div className="card owner-size-guide" style={{ maxWidth: 560, marginTop: 16 }}>
      <h3 style={{ marginTop: 0 }}>دليل المقاسات</h3>
      {error && <ErrorBanner message={error} />}
      {notice && <p className="muted" role="status">{notice}</p>}
      {!view ? (
        !error && <p className="muted">جارٍ التحميل...</p>
      ) : !view.size_guide_eligible ? (
        <p className="muted">
          {view.offer_sizes.length === 0
            ? "هذا العرض بلا مقاسات - لا يحتاج دليل مقاسات."
            : "تصنيف هذا العرض من الإكسسوارات التي لا تأخذ دليل مقاسات."}
        </p>
      ) : (
        <>
          {view.guides.length === 0 ? (
            <p className="muted">
              لا يوجد دليل مقاسات منشور ينطبق على هذا العرض بعد، لذلك لا يظهر للعميل أي رابط للدليل. يمكنك طلب دليل من الإدارة.
            </p>
          ) : (
            <ul className="owner-sg-guides">
              {view.guides.map((g) => (
                <li key={g.version_id}>
                  <div>
                    <strong>{g.name_ar}</strong>
                    <span className="muted">
                      {" "}· {g.kind === "PRODUCT" ? "دليل المنتج المرجعي" : "دليل قياسي"} · الإصدار {g.version} ·{" "}
                      {g.audiences.map((a) => AUDIENCE_LABEL[a] ?? a).join(" / ")}
                    </span>
                  </div>
                  <button type="button" className="button-link" onClick={() => setPreview(preview === g.id ? null : g.id)} aria-expanded={preview === g.id}>
                    {preview === g.id ? "إخفاء الجدول" : "عرض الجدول"}
                  </button>
                  {preview === g.id && (
                    <div style={{ overflowX: "auto", width: "100%" }}>
                      <table className="data-table">
                        <thead>
                          <tr>
                            <th>المقاس</th>
                            {g.measurements.map((m) => <th key={m.key}>{m.label_ar}</th>)}
                          </tr>
                        </thead>
                        <tbody>
                          {g.rows.map((r) => (
                            <tr key={r.size_code}>
                              <td>{r.size_label}</td>
                              {g.measurements.map((m) => <td key={m.key} dir="ltr">{formatMeasure(r.values[m.key], "cm")}</td>)}
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                </li>
              ))}
            </ul>
          )}

          {view.compatibility.checked && (
            view.compatibility.mismatched_sizes.length > 0 ? (
              <p className="owner-sg-mismatch" role="note">
                ✗ مقاسات في العرض غير موجودة في الدليل: {view.compatibility.mismatched_sizes.join("، ")}. لن يُسمح بنشر العرض
                (أو إعادة نشره) حتى تتطابق المقاسات أو يُعدَّل الدليل.
              </p>
            ) : (
              <p className="owner-sg-ok">
                ✓ كل مقاسات العرض موجودة في الدليل
                {view.compatibility.one_size_exempt && " (المقاس الموحد مستثنى لأنه غير مذكور في الدليل)"}
              </p>
            )
          )}

          {view.product_guide_applies ? (
            <p className="muted">هذا المنتج له دليل خاص من الإدارة يُعرض في كل المتاجر، ولا يمكن استبداله.</p>
          ) : selectable ? (
            <div className="field">
              <label htmlFor="owner-sg-choice">الدليل المستخدم لهذا العرض</label>
              <select
                id="owner-sg-choice"
                value={view.chosen_guide_id ?? ""}
                disabled={busy}
                onChange={(e) => choose(e.target.value || null)}
              >
                <option value="">الدليل الافتراضي للفئة</option>
                {uniqueGuides(view.options).map((g) => (
                  <option key={g.id} value={g.id}>
                    {g.name_ar}
                    {g.is_default ? " (افتراضي)" : ""}
                  </option>
                ))}
              </select>
            </div>
          ) : null}

          <div className="owner-sg-request">
            <h4>طلب دليل مخصص</h4>
            {pending ? (
              <p className="muted">لديك طلب قيد المراجعة لهذا العرض.</p>
            ) : (
              <>
                <div className="field">
                  <label htmlFor="owner-sg-message">صفي ما تحتاجينه (مثل القياسات أو طبيعة القصّة)</label>
                  <textarea
                    id="owner-sg-message"
                    rows={3}
                    maxLength={1000}
                    value={message}
                    onChange={(e) => setMessage(e.target.value)}
                    disabled={busy}
                  />
                </div>
                <button type="button" className="button" onClick={sendRequest} disabled={busy || !message.trim()}>
                  إرسال الطلب إلى الإدارة
                </button>
                <p className="muted" style={{ fontSize: ".82rem" }}>
                  الطلب لا يُنشئ دليلاً بنفسه: تراجع الإدارة القياسات وتنشئ الدليل أو تربط دليلاً معتمداً.
                </p>
              </>
            )}
            {view.requests.length > 0 && (
              <ul className="owner-sg-history">
                {view.requests.map((r) => (
                  <li key={r.id}>
                    <span className={`badge${r.status === "RESOLVED" ? " badge-active" : ""}`}>{REQUEST_STATUS_LABEL[r.status]}</span>{" "}
                    <span className="muted">{new Date(r.created_at).toLocaleDateString("ar-EG")}</span>
                    <p>{r.message}</p>
                    {r.resolved_guide && <p className="muted">الدليل المرتبط: {r.resolved_guide.name_ar}</p>}
                    {r.decision_note && <p className="muted">ملاحظة الإدارة: {r.decision_note}</p>}
                  </li>
                ))}
              </ul>
            )}
          </div>
        </>
      )}
    </div>
  );
}

function uniqueGuides(options: OwnerSizeGuideView["options"]) {
  const seen = new Map<string, OwnerSizeGuideView["options"][number]["guides"][number]>();
  for (const o of options) for (const g of o.guides) if (!seen.has(g.id) || g.is_default) seen.set(g.id, g);
  return [...seen.values()];
}

/** The API's size-guide codes, in the owner's words. */
export function sizeGuideError(err: ApiError): string {
  switch (err.code) {
    case "PRODUCT_GUIDE_APPLIES":
      return "هذا المنتج له دليل خاص لا يمكن استبداله";
    case "SIZE_GUIDE_NOT_APPLICABLE":
      return "هذا الدليل غير منشور أو لا ينطبق على فئة العرض";
    case "SIZE_GUIDE_REQUEST_PENDING":
      return "لديك طلب قيد المراجعة لهذا العرض";
    case "VENDOR_SUSPENDED":
      return "المتجر موقوف حالياً";
    default:
      return err.message;
  }
}
