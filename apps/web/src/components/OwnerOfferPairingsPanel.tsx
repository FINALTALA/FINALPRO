"use client";

import { useEffect, useState } from "react";
import { ErrorBanner } from "@/components/States";
import { apiFetch, ApiError, newIdempotencyKey } from "@/lib/api";
import { useSessionToken, useWorkspaces } from "@/lib/useSession";

interface PairingsView {
  offer_id: string;
  max: number;
  items: { offer_id: string; title_ar: string; status: string; image_url: string | null }[];
}
interface StoreOffer {
  id: string;
  title_ar: string;
  status: "DRAFT" | "ACTIVE" | "INACTIVE" | "ARCHIVED";
}

const STATUS_LABEL: Record<string, string> = {
  DRAFT: "مسودة",
  ACTIVE: "منشور",
  INACTIVE: "غير منشور",
  ARCHIVED: "مؤرشف",
};

function pairingError(err: unknown): string {
  if (!(err instanceof ApiError)) return "تعذّر حفظ التنسيق";
  switch (err.code) {
    case "VENDOR_SUSPENDED":
      return "المتجر موقوف حالياً - لا يمكن تعديل التنسيق";
    case "SUBSCRIPTION_INACTIVE":
      return "الاشتراك غير فعّال - جدّدي الاشتراك لتعديل التنسيق";
    case "PAIRED_OFFER_ARCHIVED":
      return "لا يمكن تنسيق منتج مؤرشف";
    case "OFFER_ARCHIVED":
      return "هذا العرض مؤرشف";
    case "PAIRED_OFFER_NOT_FOUND":
      return "أحد المنتجات المختارة لم يعد من منتجات المتجر";
    case "OFFER_PAIRING_SELF":
      return "لا يمكن تنسيق المنتج مع نفسه";
    default:
      return err.message;
  }
}

/**
 * PD-5.4: the owner's «نسّقي معه» for one offer - up to 6 of the store's
 * own offers, in order. Customers see only the ones that can be bought
 * at that moment (and only when at least two qualify). An employee sees
 * the list read-only; the API refuses their writes regardless.
 */
export default function OwnerOfferPairingsPanel({ vendorId, offerId }: { vendorId: string; offerId: string }) {
  const token = useSessionToken();
  const workspaces = useWorkspaces(token);
  const membership = workspaces?.find((w) => w.type === "vendor" && w.vendor_id === vendorId);
  const canEdit = membership?.type === "vendor" && membership.role === "OWNER";
  const [view, setView] = useState<PairingsView | null>(null);
  const [offers, setOffers] = useState<StoreOffer[]>([]);
  const [draft, setDraft] = useState<string[] | null>(null);
  const [adding, setAdding] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const path = `/vendors/${vendorId}/offers/${offerId}/pairings`;

  useEffect(() => {
    let cancelled = false;
    apiFetch<PairingsView>(path)
      .then((v) => {
        if (cancelled) return;
        setView(v);
        setDraft(v.items.map((i) => i.offer_id));
      })
      .catch((err) => !cancelled && setError(err instanceof ApiError ? err.message : "تعذّر تحميل التنسيق"));
    apiFetch<StoreOffer[]>(`/vendors/${vendorId}/offers`)
      .then((rows) => !cancelled && setOffers(rows))
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [path, vendorId]);

  const known = new Map<string, { title_ar: string; status: string; image_url: string | null }>();
  for (const o of offers) known.set(o.id, { title_ar: o.title_ar, status: o.status, image_url: null });
  for (const i of view?.items ?? []) known.set(i.offer_id, i);
  const list = draft ?? [];
  const max = view?.max ?? 6;
  const dirty = view !== null && list.join() !== view.items.map((i) => i.offer_id).join();
  const choices = offers.filter((o) => o.id !== offerId && o.status !== "ARCHIVED" && !list.includes(o.id));

  function move(index: number, by: -1 | 1) {
    const next = [...list];
    const target = index + by;
    if (target < 0 || target >= next.length) return;
    [next[index], next[target]] = [next[target], next[index]];
    setDraft(next);
  }

  async function save() {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const v = await apiFetch<PairingsView>(path, {
        method: "PUT",
        body: { paired_offer_ids: list },
        idempotencyKey: newIdempotencyKey("offer-pairings"),
      });
      setView(v);
      setDraft(v.items.map((i) => i.offer_id));
      setNotice("تم حفظ التنسيق");
    } catch (err) {
      setError(pairingError(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="card owner-pairings" style={{ maxWidth: 560, marginTop: 16 }}>
      <h3 style={{ marginTop: 0 }}>نسّقي معه</h3>
      <p className="muted" style={{ marginTop: 0 }}>
        اختاري حتى {max} من منتجات متجرك تُعرض مع هذا المنتج. يرى العميل فقط ما يمكن شراؤه الآن لمنطقته، ولا يظهر القسم إن بقي أقل
        من منتجين.
      </p>
      {error && <ErrorBanner message={error} />}
      {notice && <p className="muted" role="status">{notice}</p>}
      {!view ? (
        !error && <p className="muted">جارٍ التحميل...</p>
      ) : (
        <>
          {list.length === 0 ? (
            <p className="muted">لا توجد منتجات منسّقة بعد.</p>
          ) : (
            <ol className="owner-pairings-list">
              {list.map((id, index) => {
                const o = known.get(id);
                return (
                  <li key={id}>
                    <span className="owner-pairings-title">{o?.title_ar ?? "منتج"}</span>
                    {o && o.status !== "ACTIVE" && (
                      <span className="badge" title="لا يظهر للعملاء إلا وهو منشور">{STATUS_LABEL[o.status] ?? o.status}</span>
                    )}
                    {canEdit && (
                      <span className="owner-pairings-actions">
                        <button type="button" className="button-link" onClick={() => move(index, -1)} disabled={busy || index === 0} aria-label="تقديم">↑</button>
                        <button type="button" className="button-link" onClick={() => move(index, 1)} disabled={busy || index === list.length - 1} aria-label="تأخير">↓</button>
                        <button type="button" className="button-link" onClick={() => setDraft(list.filter((x) => x !== id))} disabled={busy}>
                          إزالة
                        </button>
                      </span>
                    )}
                  </li>
                );
              })}
            </ol>
          )}
          {canEdit ? (
            <>
              <div className="owner-pairings-add">
                <select
                  aria-label="إضافة منتج للتنسيق"
                  value={adding}
                  onChange={(e) => setAdding(e.target.value)}
                  disabled={busy || list.length >= max}
                >
                  <option value="">{list.length >= max ? `وصلتِ للحد (${max})` : "— اختاري منتجاً من متجرك —"}</option>
                  {choices.map((o) => (
                    <option key={o.id} value={o.id}>
                      {o.title_ar}
                      {o.status !== "ACTIVE" ? ` (${STATUS_LABEL[o.status]})` : ""}
                    </option>
                  ))}
                </select>
                <button
                  type="button"
                  className="button-link"
                  disabled={busy || !adding || list.length >= max}
                  onClick={() => {
                    setDraft([...list, adding]);
                    setAdding("");
                  }}
                >
                  إضافة
                </button>
              </div>
              <button type="button" className="button" onClick={save} disabled={busy || !dirty}>
                حفظ التنسيق
              </button>
            </>
          ) : (
            <p className="muted" style={{ fontSize: ".82rem" }}>يعدّل التنسيق صاحب المتجر فقط.</p>
          )}
        </>
      )}
    </div>
  );
}
