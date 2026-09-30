"use client";

import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { ErrorBanner } from "@/components/States";
import { apiFetch, ApiError, newIdempotencyKey } from "@/lib/api";
import { getSessionToken } from "@/lib/session";

interface VariantDto {
  id: string;
  seller_sku: string;
  condition: "NEW" | "USED" | "REFURBISHED" | "OPEN_BOX";
  base_price: string;
  sale_price: string | null;
  discount_percent: string | null;
  discount_start_at: string | null;
  discount_end_at: string | null;
  effective_price: number;
  colour: string | null;
  size: string | null;
  specs_text_ar: string | null;
  specs_text_en: string | null;
  identifier_type: string | null;
  identifier_value: string | null;
  match_proposal_status: "NONE" | "PENDING" | "CONFIRMED" | "REJECTED";
  proposed_canonical_variant_id: string | null;
}

interface MediaDto {
  id: string;
  url: string;
  kind: "PRIMARY" | "ADDITIONAL";
  media_type: "IMAGE" | "VIDEO";
  alt_text_ar: string | null;
  alt_text_en: string | null;
  sort_order: number;
}

interface PriceHistoryRow {
  id: string;
  base_price: string;
  sale_price: string | null;
  discount_percent: string | null;
  effective_price_at_change: string;
  reason: string;
  changed_at: string;
}

interface OfferSummaryDto {
  canonical_product_id: string | null;
}

interface NameChangeRequestDto {
  id: string;
  canonical_product_id: string;
  requested_name_ar: string;
  requested_name_en: string;
  reason: string | null;
  status: "PENDING" | "APPROVED" | "REJECTED";
  decided_at: string | null;
  created_at: string;
}

const NAME_CHANGE_STATUS_LABEL: Record<NameChangeRequestDto["status"], string> = {
  PENDING: "بانتظار قرار المنصة",
  APPROVED: "تمت الموافقة",
  REJECTED: "تم الرفض",
};

type PriceMode = "none" | "sale" | "discount";

const MATCH_LABEL: Record<VariantDto["match_proposal_status"], string> = {
  NONE: "غير مطابق",
  PENDING: "تطابق مقترح - بانتظار القرار",
  CONFIRMED: "مؤكد المطابقة",
  REJECTED: "تم رفض التطابق",
};

// Sprint 17 (blocker 1/D9): the owner's variant edit page - pricing/
// discounts with the full mutual-exclusivity UI, media management
// (add/reorder/alt-text/delete, 10 image/3 video limits enforced
// server-side), price history, and the match confirmation decision.
export default function VariantDetailPage() {
  const params = useParams<{ vendorId: string; offerId: string; variantId: string }>();
  const router = useRouter();
  const base = `/vendors/${params.vendorId}/offers/${params.offerId}/variants/${params.variantId}`;

  const [variant, setVariant] = useState<VariantDto | null>(null);
  const [media, setMedia] = useState<MediaDto[] | null>(null);
  const [history, setHistory] = useState<PriceHistoryRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const [basePrice, setBasePrice] = useState("");
  const [condition, setCondition] = useState("NEW");
  const [colour, setColour] = useState("");
  const [size, setSize] = useState("");
  const [specsAr, setSpecsAr] = useState("");
  const [specsEn, setSpecsEn] = useState("");
  const [priceMode, setPriceMode] = useState<PriceMode>("none");
  const [salePrice, setSalePrice] = useState("");
  const [discountPercent, setDiscountPercent] = useState("");
  const [discountStart, setDiscountStart] = useState("");
  const [discountEnd, setDiscountEnd] = useState("");

  const [newMediaUrl, setNewMediaUrl] = useState("");
  const [newMediaKind, setNewMediaKind] = useState<"PRIMARY" | "ADDITIONAL">("ADDITIONAL");
  const [newMediaType, setNewMediaType] = useState<"IMAGE" | "VIDEO">("IMAGE");

  // Review-round fix (owner matching UI): the offer's own
  // canonical_product_id (not variant.canonical_variant_id) is the
  // exact condition requestNameChange() checks server-side
  // (hasConfirmedMatch on VendorOffer) - gating the button on anything
  // else could show it when the request would 403/404, or hide it when
  // it would actually succeed.
  const [offerCanonicalProductId, setOfferCanonicalProductId] = useState<string | null>(null);
  // Review-round fix: a failed offer-summary load must not look like
  // "this offer has no confirmed match" - offerCanonicalProductId
  // would stay null either way, so a separate error state is what lets
  // the render below tell "unknown (load failed)" apart from "known:
  // none" and show a real retry instead of silently hiding the whole
  // rename-request section.
  const [offerSummaryError, setOfferSummaryError] = useState<string | null>(null);
  const [nameChangeRequests, setNameChangeRequests] = useState<NameChangeRequestDto[] | null>(null);
  // Review-round fix: a failed load must never be indistinguishable
  // from "no requests yet" - null above means "not loaded/unknown",
  // this error means "loaded and failed", and only a successful (even
  // empty) array means "loaded and there really are none".
  const [nameChangeRequestsError, setNameChangeRequestsError] = useState<string | null>(null);
  const [newNameAr, setNewNameAr] = useState("");
  const [newNameEn, setNewNameEn] = useState("");
  const [newNameReason, setNewNameReason] = useState("");

  // Review-round fix: a request sequence guard against navigating
  // between variants (offers/[offerId]/variants/[variantId] is one
  // component instance reused across param changes, not remounted -
  // Next.js client-side nav keeps it mounted). Without this, a slow
  // response for the PREVIOUS variant/offer could resolve after
  // load() already started fetching the NEW one and overwrite its
  // state - most visibly, the previous offer's canonical_product_id
  // (and its name-change-request list/form) staying on screen, or a
  // manual retry firing against the wrong canonical id.
  //
  // This route (offers/[offerId]/variants/[variantId]) actually
  // UNMOUNTS and remounts this component on every variant navigation
  // (verified directly - not just a param change reusing one mounted
  // instance), so a counter living only in a plain `useRef` and bumped
  // inside load() cannot detect staleness across that boundary: a
  // fresh mount gets a fresh, disconnected ref, and the OLD, now-
  // orphaned instance's own ref is never touched again, so its stale
  // callback's "is this still current" check always reads as "yes"
  // against itself. What DOES reliably fire on both an effect re-run
  // AND a true unmount is the effect's own cleanup function below -
  // every async callback checks the SAME `cancelledRef` that cleanup
  // sets, not a counter.
  const cancelledRef = useRef(false);

  function load() {
    // Offer-scoped state belongs to the offer/variant this load() call
    // is for - clear it immediately so the previous offer's canonical
    // match/name-change data can never still be on screen while the
    // new one loads.
    setOfferCanonicalProductId(null);
    setOfferSummaryError(null);
    setNameChangeRequests(null);
    setNameChangeRequestsError(null);

    apiFetch<VariantDto[]>(`/vendors/${params.vendorId}/offers/${params.offerId}/variants`)
      .then((all) => {
        if (cancelledRef.current) return;
        const v = all.find((x) => x.id === params.variantId);
        if (v) {
          setVariant(v);
          setBasePrice(v.base_price);
          setCondition(v.condition);
          setColour(v.colour ?? "");
          setSize(v.size ?? "");
          setSpecsAr(v.specs_text_ar ?? "");
          setSpecsEn(v.specs_text_en ?? "");
          if (v.discount_percent) {
            setPriceMode("discount");
            setDiscountPercent(v.discount_percent);
            setDiscountStart(v.discount_start_at ?? "");
            setDiscountEnd(v.discount_end_at ?? "");
          } else if (v.sale_price) {
            setPriceMode("sale");
            setSalePrice(v.sale_price);
          } else {
            setPriceMode("none");
          }
        } else {
          setError("تعذّر العثور على هذا المتغيّر");
        }
      })
      .catch((err) => {
        if (cancelledRef.current) return;
        setError(err instanceof ApiError ? err.message : "تعذّر تحميل المتغيّر");
      });
    apiFetch<MediaDto[]>(`${base}/media`)
      .then((m) => {
        if (!cancelledRef.current) setMedia(m);
      })
      .catch(() => {});
    apiFetch<PriceHistoryRow[]>(`${base}/price-history`)
      .then((h) => {
        if (!cancelledRef.current) setHistory(h);
      })
      .catch(() => {});
    loadOfferSummary();
  }

  function loadOfferSummary() {
    setOfferSummaryError(null);
    apiFetch<OfferSummaryDto>(`/vendors/${params.vendorId}/offers/${params.offerId}`)
      .then((offer) => {
        if (cancelledRef.current) return;
        setOfferCanonicalProductId(offer.canonical_product_id);
        if (offer.canonical_product_id) {
          loadNameChangeRequests(offer.canonical_product_id);
        } else {
          setNameChangeRequests(null);
          setNameChangeRequestsError(null);
        }
      })
      .catch((err) => {
        if (cancelledRef.current) return;
        setOfferSummaryError(
          err instanceof ApiError ? err.message : "تعذّر تحميل بيانات العرض",
        );
      });
  }

  function loadNameChangeRequests(canonicalProductId: string) {
    setNameChangeRequestsError(null);
    apiFetch<NameChangeRequestDto[]>(
      `/vendors/${params.vendorId}/canonical-products/${canonicalProductId}/name-change-requests`,
    )
      .then((r) => {
        if (cancelledRef.current) return;
        setNameChangeRequests(r);
      })
      .catch((err) => {
        if (cancelledRef.current) return;
        setNameChangeRequestsError(
          err instanceof ApiError ? err.message : "تعذّر تحميل طلبات تغيير الاسم",
        );
      });
  }

  useEffect(() => {
    if (!getSessionToken()) {
      router.replace("/login");
      return;
    }
    cancelledRef.current = false;
    // Deferred one microtask - load() itself calls setState
    // synchronously (the offer-scoped resets above), which React's
    // set-state-in-effect rule flags when reachable directly from the
    // effect body; every fetch load() issues is genuinely async
    // regardless, so this costs nothing real.
    Promise.resolve().then(load);
    // This cleanup is what actually makes cancelledRef reliable - it
    // runs before every later re-run of this effect AND on a genuine
    // unmount (this route remounts the component on each variant
    // navigation - see cancelledRef's own comment above), so any
    // fetch this specific effect run started is marked stale the
    // moment it stops being the current one, regardless of which of
    // those two cases actually happened.
    return () => {
      cancelledRef.current = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [params.vendorId, params.offerId, params.variantId]);

  const identityLocked = variant?.match_proposal_status === "CONFIRMED";

  async function savePrice() {
    if (!variant) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const body: Record<string, unknown> = {};
      if (basePrice !== variant.base_price) body.base_price = Number(basePrice);
      if (priceMode === "none") {
        body.sale_price = null;
        body.discount_percent = null;
        body.discount_start_at = null;
        body.discount_end_at = null;
      } else if (priceMode === "sale") {
        body.sale_price = Number(salePrice);
      } else if (priceMode === "discount") {
        body.discount_percent = Number(discountPercent);
        body.discount_start_at = new Date(discountStart).toISOString();
        body.discount_end_at = new Date(discountEnd).toISOString();
      }
      if (condition !== variant.condition) body.condition = condition;
      if (colour !== (variant.colour ?? "")) body.colour = colour;
      if (size !== (variant.size ?? "")) body.size = size;
      if (specsAr !== (variant.specs_text_ar ?? "")) body.specs_text_ar = specsAr;
      if (specsEn !== (variant.specs_text_en ?? "")) body.specs_text_en = specsEn;
      await apiFetch(base, { method: "PUT", body });
      setNotice("تم حفظ السعر");
      load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "تعذّر حفظ السعر");
    } finally {
      setBusy(false);
    }
  }

  async function decideMatch(decision: "confirm" | "reject") {
    setBusy(true);
    setError(null);
    try {
      await apiFetch(`${base}/match-confirmation`, {
        method: "POST",
        body: { decision },
        idempotencyKey: newIdempotencyKey("match-decision"),
      });
      setNotice(decision === "confirm" ? "تم تأكيد المطابقة" : "تم رفض المطابقة");
      load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "تعذّر تنفيذ القرار");
    } finally {
      setBusy(false);
    }
  }

  async function requestNameChange() {
    if (!offerCanonicalProductId || !newNameAr.trim() || !newNameEn.trim()) return;
    setBusy(true);
    setError(null);
    try {
      await apiFetch(
        `/vendors/${params.vendorId}/canonical-products/${offerCanonicalProductId}/name-change-requests`,
        {
          method: "POST",
          body: {
            requested_name_ar: newNameAr.trim(),
            requested_name_en: newNameEn.trim(),
            reason: newNameReason.trim() || undefined,
          },
          idempotencyKey: newIdempotencyKey("name-change-request"),
        },
      );
      setNewNameAr("");
      setNewNameEn("");
      setNewNameReason("");
      setNotice("تم إرسال طلب تغيير الاسم");
      load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "تعذّر إرسال الطلب");
    } finally {
      setBusy(false);
    }
  }

  async function addMedia() {
    if (!newMediaUrl.trim()) return;
    setBusy(true);
    setError(null);
    try {
      await apiFetch(`${base}/media`, {
        method: "POST",
        body: { url: newMediaUrl.trim(), kind: newMediaKind, media_type: newMediaType },
        idempotencyKey: newIdempotencyKey("media-add"),
      });
      setNewMediaUrl("");
      setNotice("تمت إضافة الوسائط");
      load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "تعذّر إضافة الوسائط");
    } finally {
      setBusy(false);
    }
  }

  async function deleteMedia(id: string) {
    setBusy(true);
    setError(null);
    try {
      await apiFetch(`${base}/media/${id}`, { method: "DELETE" });
      setNotice("تم حذف الوسائط");
      load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "تعذّر الحذف");
    } finally {
      setBusy(false);
    }
  }

  async function saveAltText(id: string, altAr: string, altEn: string) {
    setBusy(true);
    setError(null);
    try {
      await apiFetch(`${base}/media/${id}`, {
        method: "PATCH",
        body: { alt_text_ar: altAr, alt_text_en: altEn },
      });
      setNotice("تم حفظ الوصف البديل");
      load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "تعذّر الحفظ");
    } finally {
      setBusy(false);
    }
  }

  async function moveMedia(index: number, direction: -1 | 1) {
    if (!media) return;
    const target = index + direction;
    if (target < 0 || target >= media.length) return;
    const reordered = [...media];
    [reordered[index], reordered[target]] = [reordered[target], reordered[index]];
    setBusy(true);
    setError(null);
    try {
      const updated = await apiFetch<MediaDto[]>(`${base}/media/reorder`, {
        method: "PUT",
        body: { media_ids: reordered.map((m) => m.id) },
      });
      setMedia(updated);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "تعذّر إعادة الترتيب");
    } finally {
      setBusy(false);
    }
  }

  if (!variant) {
    return (
      <div className="page-shell">
        {error ? <ErrorBanner message={error} /> : <p className="muted">جارٍ التحميل...</p>}
      </div>
    );
  }

  return (
    <div className="page-shell">
      <div className="top-bar">
        <h1 className="page-title" style={{ margin: 0 }}>متغيّر: {variant.seller_sku}</h1>
        <Link href={`/vendor/${params.vendorId}/offers/${params.offerId}`} className="button-link">
          العودة للعرض
        </Link>
      </div>
      {error && <ErrorBanner message={error} />}
      {notice && <p className="muted">{notice}</p>}

      {variant.match_proposal_status === "PENDING" && (
        <div className="card" style={{ maxWidth: 560, borderColor: "#e0a800" }}>
          <h3 style={{ marginTop: 0 }}>تطابق مقترح مع منتج مرجعي</h3>
          <p className="muted">
            وجد النظام تطابقًا محتملًا بالمعرّف الدولي. أكّدي المطابقة لربط هذا المتغيّر بالمنتج المرجعي، أو
            ارفضيه إن لم يكن صحيحًا.
          </p>
          <div style={{ display: "flex", gap: 8 }}>
            <button className="button" onClick={() => decideMatch("confirm")} disabled={busy}>
              تأكيد المطابقة
            </button>
            <button className="button-link" onClick={() => decideMatch("reject")} disabled={busy}>
              رفض المطابقة
            </button>
          </div>
        </div>
      )}
      {variant.match_proposal_status !== "NONE" && variant.match_proposal_status !== "PENDING" && (
        <p className="muted">حالة المطابقة: {MATCH_LABEL[variant.match_proposal_status]}</p>
      )}

      <div className="card" style={{ maxWidth: 560, marginTop: 16 }}>
        <h3 style={{ marginTop: 0 }}>السعر والخيارات</h3>
        <div className="field">
          <label>سعر الأساس (₪)</label>
          <input type="number" value={basePrice} onChange={(e) => setBasePrice(e.target.value)} />
        </div>
        <div className="field">
          <label>حالة المنتج</label>
          <select value={condition} onChange={(e) => setCondition(e.target.value)}>
            <option value="NEW">جديد</option>
            <option value="USED">مستعمل</option>
            <option value="REFURBISHED">مجدّد</option>
            <option value="OPEN_BOX">علبة مفتوحة</option>
          </select>
        </div>
        <div className="field">
          <label>اللون</label>
          <input value={colour} onChange={(e) => setColour(e.target.value)} disabled={identityLocked} />
        </div>
        <div className="field">
          <label>المقاس</label>
          <input value={size} onChange={(e) => setSize(e.target.value)} disabled={identityLocked} />
        </div>
        <div className="field">
          <label>مواصفات نصّية بالعربية</label>
          <input value={specsAr} onChange={(e) => setSpecsAr(e.target.value)} />
        </div>
        <div className="field">
          <label>مواصفات نصّية بالإنجليزية</label>
          <input value={specsEn} onChange={(e) => setSpecsEn(e.target.value)} />
        </div>
        <div className="field">
          <label>نمط السعر</label>
          <select value={priceMode} onChange={(e) => setPriceMode(e.target.value as PriceMode)}>
            <option value="none">بدون تخفيض</option>
            <option value="sale">سعر مخفّض ثابت</option>
            <option value="discount">خصم مجدوَل</option>
          </select>
        </div>
        {priceMode === "sale" && (
          <div className="field">
            <label>السعر بعد التخفيض (₪)</label>
            <input type="number" value={salePrice} onChange={(e) => setSalePrice(e.target.value)} />
          </div>
        )}
        {priceMode === "discount" && (
          <>
            <div className="field">
              <label>نسبة الخصم (%)</label>
              <input
                type="number"
                value={discountPercent}
                onChange={(e) => setDiscountPercent(e.target.value)}
              />
            </div>
            <div className="field">
              <label>بداية الخصم</label>
              <input
                type="datetime-local"
                value={discountStart?.slice(0, 16) ?? ""}
                onChange={(e) => setDiscountStart(e.target.value)}
              />
            </div>
            <div className="field">
              <label>نهاية الخصم</label>
              <input
                type="datetime-local"
                value={discountEnd?.slice(0, 16) ?? ""}
                onChange={(e) => setDiscountEnd(e.target.value)}
              />
            </div>
          </>
        )}
        <p className="muted">السعر الحالي المعروض للعملاء: {variant.effective_price.toFixed(2)} ₪</p>
        <button className="button" onClick={savePrice} disabled={busy}>
          حفظ السعر
        </button>
      </div>

      <div className="card" style={{ maxWidth: 560, marginTop: 16 }}>
        <h3 style={{ marginTop: 0 }}>الوسائط (صور/فيديو)</h3>
        <p className="muted">صورة رئيسية واحدة (IMAGE فقط) مطلوبة قبل النشر. الحد: 10 صور، 3 فيديوهات.</p>
        {(media ?? []).map((m, i) => (
          <MediaRow
            key={m.id}
            media={m}
            index={i}
            total={media?.length ?? 0}
            busy={busy}
            onDelete={() => deleteMedia(m.id)}
            onMove={(dir) => moveMedia(i, dir)}
            onSaveAlt={(ar, en) => saveAltText(m.id, ar, en)}
          />
        ))}
        <div className="field">
          <label>رابط الوسائط</label>
          <input value={newMediaUrl} onChange={(e) => setNewMediaUrl(e.target.value)} placeholder="https://..." />
        </div>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <select value={newMediaKind} onChange={(e) => setNewMediaKind(e.target.value as "PRIMARY" | "ADDITIONAL")}>
            <option value="ADDITIONAL">إضافية</option>
            <option value="PRIMARY">رئيسية</option>
          </select>
          <select value={newMediaType} onChange={(e) => setNewMediaType(e.target.value as "IMAGE" | "VIDEO")}>
            <option value="IMAGE">صورة</option>
            <option value="VIDEO">فيديو</option>
          </select>
          <button className="button" onClick={addMedia} disabled={busy}>
            إضافة
          </button>
        </div>
      </div>

      <div className="wide-shell" style={{ marginTop: 16 }}>
        <h3>سجلّ الأسعار</h3>
        {history && history.length > 0 && (
          <div style={{ overflowX: "auto" }}>
            <table className="data-table">
              <thead>
                <tr>
                  <th>التاريخ</th>
                  <th>السعر الأساسي</th>
                  <th>السعر بعد التخفيض</th>
                  <th>السعر الفعلي حينها</th>
                  <th>السبب</th>
                </tr>
              </thead>
              <tbody>
                {history.map((h) => (
                  <tr key={h.id}>
                    <td>{new Date(h.changed_at).toLocaleString("ar")}</td>
                    <td>{h.base_price}</td>
                    <td>{h.sale_price ?? (h.discount_percent ? `${h.discount_percent}%` : "—")}</td>
                    <td>{h.effective_price_at_change}</td>
                    <td>{h.reason}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {offerSummaryError && (
        <div className="card" style={{ maxWidth: 560, marginTop: 16 }}>
          <h3 style={{ marginTop: 0 }}>طلب تغيير اسم المنتج المرجعي</h3>
          <ErrorBanner message={offerSummaryError} />
          <button className="button-link" onClick={loadOfferSummary}>
            إعادة المحاولة
          </button>
        </div>
      )}
      {!offerSummaryError && offerCanonicalProductId && (
        <div className="card" style={{ maxWidth: 560, marginTop: 16 }}>
          <h3 style={{ marginTop: 0 }}>طلب تغيير اسم المنتج المرجعي</h3>
          <p className="muted">
            هذا العرض مطابق لمنتج مرجعي. إن رأيتِ اسمه غير دقيق، يمكنك اقتراح اسم بديل يراجعه فريق المنصة.
          </p>
          {nameChangeRequestsError && (
            <div style={{ marginBottom: 8 }}>
              <ErrorBanner message={nameChangeRequestsError} />
              <button
                className="button-link"
                onClick={() => loadNameChangeRequests(offerCanonicalProductId)}
              >
                إعادة المحاولة
              </button>
            </div>
          )}
          {!nameChangeRequestsError && nameChangeRequests === null && (
            <p className="muted">جارٍ تحميل طلبات تغيير الاسم السابقة...</p>
          )}
          {!nameChangeRequestsError && nameChangeRequests && nameChangeRequests.length > 0 && (
            <ul style={{ margin: "8px 0", paddingInlineStart: 20 }}>
              {nameChangeRequests.map((r) => (
                <li key={r.id} className="muted">
                  {r.requested_name_ar} / {r.requested_name_en} —{" "}
                  <span className={`badge${r.status === "APPROVED" ? " badge-active" : ""}`}>
                    {NAME_CHANGE_STATUS_LABEL[r.status]}
                  </span>
                </li>
              ))}
            </ul>
          )}
          <div className="field">
            <label>الاسم المقترح بالعربية</label>
            <input value={newNameAr} onChange={(e) => setNewNameAr(e.target.value)} />
          </div>
          <div className="field">
            <label>الاسم المقترح بالإنجليزية</label>
            <input value={newNameEn} onChange={(e) => setNewNameEn(e.target.value)} />
          </div>
          <div className="field">
            <label>سبب التغيير (اختياري)</label>
            <input value={newNameReason} onChange={(e) => setNewNameReason(e.target.value)} />
          </div>
          <button
            className="button"
            onClick={requestNameChange}
            disabled={busy || !newNameAr.trim() || !newNameEn.trim()}
          >
            إرسال الطلب
          </button>
        </div>
      )}
    </div>
  );
}

function MediaRow({
  media,
  index,
  total,
  busy,
  onDelete,
  onMove,
  onSaveAlt,
}: {
  media: MediaDto;
  index: number;
  total: number;
  busy: boolean;
  onDelete: () => void;
  onMove: (dir: -1 | 1) => void;
  onSaveAlt: (altAr: string, altEn: string) => void;
}) {
  const [altAr, setAltAr] = useState(media.alt_text_ar ?? "");
  const [altEn, setAltEn] = useState(media.alt_text_en ?? "");
  return (
    <div style={{ display: "flex", gap: 10, alignItems: "flex-start", padding: "8px 0", borderBottom: "1px solid #eee" }}>
      {media.media_type === "IMAGE" ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={media.url} alt={altEn || "media"} style={{ width: 64, height: 64, objectFit: "cover", borderRadius: 6 }} />
      ) : (
        <div style={{ width: 64, height: 64, background: "#eee", borderRadius: 6, display: "flex", alignItems: "center", justifyContent: "center" }}>
          فيديو
        </div>
      )}
      <div style={{ flex: 1, minWidth: 200 }}>
        <div>
          <span className={`badge${media.kind === "PRIMARY" ? " badge-active" : ""}`}>
            {media.kind === "PRIMARY" ? "رئيسية" : "إضافية"}
          </span>{" "}
          {media.media_type === "IMAGE" ? "صورة" : "فيديو"}
        </div>
        <input placeholder="وصف بديل (عربي)" value={altAr} onChange={(e) => setAltAr(e.target.value)} style={{ marginTop: 4 }} />
        <input placeholder="وصف بديل (إنجليزي)" value={altEn} onChange={(e) => setAltEn(e.target.value)} style={{ marginTop: 4 }} />
        <button className="button-link" onClick={() => onSaveAlt(altAr, altEn)} disabled={busy}>
          حفظ الوصف
        </button>
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
        <button className="button-link" onClick={() => onMove(-1)} disabled={busy || index === 0}>
          ↑
        </button>
        <button className="button-link" onClick={() => onMove(1)} disabled={busy || index === total - 1}>
          ↓
        </button>
        <button className="button-link" onClick={onDelete} disabled={busy}>
          حذف
        </button>
      </div>
    </div>
  );
}
