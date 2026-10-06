"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { useEffect, useState } from "react";
import { EmptyState, ErrorBanner } from "@/components/States";
import { ApiError, apiFetch, newIdempotencyKey } from "@/lib/api";
import {
  CANONICAL_PRODUCT_STATUS_LABEL,
  PRODUCT_TYPE_LABEL,
  adminErrorMessage,
  reasonProblem,
} from "@/lib/admin";
import { useAdminGate } from "@/lib/useAdminGate";
import { useFetch } from "@/lib/useFetch";

type ProductType = "PHYSICAL" | "BUNDLE" | "SERVICE";
type ProductStatus = "DRAFT" | "PENDING_REVIEW" | "PUBLISHED" | "ARCHIVED" | "MERGED";

interface VariantDto {
  id: string;
  canonical_product_id: string;
  structural_attributes: Record<string, unknown>;
  mpn: string | null;
  gtin: string | null;
}

interface CanonicalProductDetailDto {
  id: string;
  brand_id: string;
  category_id: string;
  model_name: string;
  status: ProductStatus;
  canonical_name_ar: string | null;
  canonical_name_en: string | null;
  product_type: ProductType;
  warranty_period: number | null;
  warranty_type: string | null;
  tags: string[];
  seo_title_ar: string | null;
  seo_title_en: string | null;
  seo_description_ar: string | null;
  seo_description_en: string | null;
  is_restricted: boolean;
  merged_into_id: string | null;
  variants: VariantDto[];
}

interface BrandRow {
  id: string;
  name: string;
}

interface CategoryRow {
  id: string;
  name_ar: string;
}

interface CanonicalProductListRow {
  id: string;
  model_name: string;
  canonical_name_ar: string | null;
  status: ProductStatus;
}

interface UnmatchedVariant {
  loser_variant_id: string;
  match_count: number;
}

interface BlockedVendorOffer {
  vendor_offer_id: string;
}

// The exact legal status_transition edges (canonical-products.
// controller.ts's status-transition rules) - never a free dropdown of
// every status, only the buttons that would actually succeed.
const TRANSITIONS: Record<ProductStatus, { to: ProductStatus; label: string }[]> = {
  DRAFT: [
    { to: "PENDING_REVIEW", label: "إرسال للمراجعة" },
    { to: "ARCHIVED", label: "أرشفة" },
  ],
  PENDING_REVIEW: [
    { to: "PUBLISHED", label: "نشر" },
    { to: "DRAFT", label: "إرجاع لمسودة" },
  ],
  PUBLISHED: [{ to: "ARCHIVED", label: "أرشفة" }],
  ARCHIVED: [{ to: "PUBLISHED", label: "إعادة نشر" }],
  MERGED: [],
};

type Panel = "none" | "restrict" | "unrestrict" | "merge" | "split";

// Sprint 17b: the platform admin's canonical-product detail page -
// editable fields, variant list/add, the legal status-transition
// buttons only, restrict/unrestrict, and the merge/split entry points.
// A MERGED product is a dead end in the UI by design - no action
// buttons at all, just a note pointing at the survivor.
export default function AdminCanonicalProductDetailPage() {
  const gate = useAdminGate("ADMIN");
  const params = useParams<{ id: string }>();
  const [nonce, setNonce] = useState(0);
  const detail = useFetch<CanonicalProductDetailDto>(
    gate.status === "ok" ? `/canonical-products/${params.id}?r=${nonce}` : null,
    true,
  );
  function reload() {
    setNonce((n) => n + 1);
  }
  const d = detail.data;

  const [notice, setNotice] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // --- editable fields ---
  const [productType, setProductType] = useState<ProductType>("PHYSICAL");
  const [warrantyPeriod, setWarrantyPeriod] = useState("");
  const [warrantyType, setWarrantyType] = useState("");
  const [tagsText, setTagsText] = useState("");
  const [seoTitleAr, setSeoTitleAr] = useState("");
  const [seoTitleEn, setSeoTitleEn] = useState("");
  const [seoDescAr, setSeoDescAr] = useState("");
  const [seoDescEn, setSeoDescEn] = useState("");
  const [fieldsBusy, setFieldsBusy] = useState(false);
  const [fieldsError, setFieldsError] = useState<string | null>(null);
  const [fieldsNotice, setFieldsNotice] = useState<string | null>(null);

  useEffect(() => {
    if (!d) return;
    // Deferred one microtask - setting several pieces of state directly
    // in an effect body is what react-hooks/set-state-in-effect warns
    // against (cascading renders); the data is already loaded async by
    // useFetch, so this costs nothing real. Same reasoning as the
    // deferred load() call on the owner's variant detail page.
    Promise.resolve().then(() => {
      setProductType(d.product_type);
      setWarrantyPeriod(d.warranty_period != null ? String(d.warranty_period) : "");
      setWarrantyType(d.warranty_type ?? "");
      setTagsText((d.tags ?? []).join(", "));
      setSeoTitleAr(d.seo_title_ar ?? "");
      setSeoTitleEn(d.seo_title_en ?? "");
      setSeoDescAr(d.seo_description_ar ?? "");
      setSeoDescEn(d.seo_description_en ?? "");
    });
  }, [d]);

  async function saveFields() {
    setFieldsBusy(true);
    setFieldsError(null);
    setFieldsNotice(null);
    try {
      const tags = tagsText
        .split(",")
        .map((t) => t.trim())
        .filter(Boolean);
      await apiFetch(`/canonical-products/${params.id}`, {
        method: "PATCH",
        body: {
          product_type: productType,
          warranty_period: warrantyPeriod.trim() === "" ? null : Number(warrantyPeriod),
          warranty_type: warrantyType.trim() || null,
          tags,
          seo_title_ar: seoTitleAr.trim() || null,
          seo_title_en: seoTitleEn.trim() || null,
          seo_description_ar: seoDescAr.trim() || null,
          seo_description_en: seoDescEn.trim() || null,
        },
      });
      setFieldsNotice("تم حفظ التعديلات");
      reload();
    } catch (err) {
      setFieldsError(adminErrorMessage(err));
    } finally {
      setFieldsBusy(false);
    }
  }

  // --- status transition ---
  async function transition(to: ProductStatus) {
    setBusy(true);
    setActionError(null);
    setNotice(null);
    try {
      await apiFetch(`/canonical-products/${params.id}/status-transition`, {
        method: "POST",
        body: { to_status: to },
        idempotencyKey: newIdempotencyKey("canonical-product-status"),
      });
      setNotice("تم تغيير حالة المنتج");
      reload();
    } catch (err) {
      setActionError(adminErrorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  // --- restrict / unrestrict ---
  const [panel, setPanel] = useState<Panel>("none");
  const [reason, setReason] = useState("");
  const problem = reasonProblem(reason);

  function openPanel(next: Panel) {
    setPanel(next);
    setReason("");
    setActionError(null);
    setNotice(null);
  }

  async function submitRestrict(mode: "restrict" | "unrestrict") {
    if (mode === "restrict" && problem) return;
    setBusy(true);
    setActionError(null);
    try {
      await apiFetch(`/canonical-products/${params.id}/${mode}`, {
        method: "POST",
        body: mode === "restrict" ? { reason: reason.trim() } : undefined,
        idempotencyKey: newIdempotencyKey(`canonical-product-${mode}`),
      });
      setNotice(mode === "restrict" ? "تم تقييد المنتج" : "تم إلغاء تقييد المنتج");
      setPanel("none");
      reload();
    } catch (err) {
      setActionError(adminErrorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  // --- add variant (key/value structural attributes editor) ---
  const [attrRows, setAttrRows] = useState<{ key: string; value: string }[]>([{ key: "", value: "" }]);
  const [mpn, setMpn] = useState("");
  const [gtin, setGtin] = useState("");
  const [variantBusy, setVariantBusy] = useState(false);
  const [variantError, setVariantError] = useState<string | null>(null);

  function updateAttrRow(index: number, field: "key" | "value", value: string) {
    setAttrRows((rows) => rows.map((r, i) => (i === index ? { ...r, [field]: value } : r)));
  }

  async function addVariant() {
    setVariantBusy(true);
    setVariantError(null);
    try {
      const structural_attributes: Record<string, string> = {};
      for (const row of attrRows) {
        if (row.key.trim()) structural_attributes[row.key.trim()] = row.value;
      }
      await apiFetch(`/canonical-products/${params.id}/variants`, {
        method: "POST",
        body: {
          structural_attributes,
          mpn: mpn.trim() || undefined,
          gtin: gtin.trim() || undefined,
        },
        idempotencyKey: newIdempotencyKey("canonical-variant-create"),
      });
      setAttrRows([{ key: "", value: "" }]);
      setMpn("");
      setGtin("");
      reload();
    } catch (err) {
      setVariantError(adminErrorMessage(err));
    } finally {
      setVariantBusy(false);
    }
  }

  // --- merge (:id is the loser, body names the survivor) ---
  const [mergeQuery, setMergeQuery] = useState("");
  const [mergeTargetId, setMergeTargetId] = useState<string | null>(null);
  const [mergeConfirming, setMergeConfirming] = useState(false);
  const [mergeBusy, setMergeBusy] = useState(false);
  const [mergeError, setMergeError] = useState<string | null>(null);
  const [mergeUnmatched, setMergeUnmatched] = useState<UnmatchedVariant[] | null>(null);
  const allProducts = useFetch<CanonicalProductListRow[]>(panel === "merge" ? "/canonical-products" : null);
  const mergeCandidates = (allProducts.data ?? []).filter(
    (p) =>
      p.id !== params.id &&
      p.status !== "MERGED" &&
      (p.canonical_name_ar ?? p.model_name).toLowerCase().includes(mergeQuery.trim().toLowerCase()),
  );

  async function submitMerge() {
    if (!mergeTargetId) return;
    setMergeBusy(true);
    setMergeError(null);
    setMergeUnmatched(null);
    try {
      await apiFetch(`/canonical-products/${params.id}/merge`, {
        method: "POST",
        body: { into_canonical_product_id: mergeTargetId },
        idempotencyKey: newIdempotencyKey("canonical-product-merge"),
      });
      setNotice("تم دمج المنتج بنجاح");
      setPanel("none");
      setMergeConfirming(false);
      setMergeTargetId(null);
      setMergeQuery("");
      reload();
    } catch (err) {
      if (err instanceof ApiError && err.code === "MERGE_VARIANT_UNMATCHED") {
        setMergeUnmatched((err.details as UnmatchedVariant[]) ?? []);
      } else {
        setMergeError(adminErrorMessage(err));
      }
    } finally {
      setMergeBusy(false);
    }
  }

  // --- split (:id is the source) ---
  const [splitVariantIds, setSplitVariantIds] = useState<string[]>([]);
  const [splitBrandId, setSplitBrandId] = useState("");
  const [splitCategoryId, setSplitCategoryId] = useState("");
  const [splitModelName, setSplitModelName] = useState("");
  const [splitBusy, setSplitBusy] = useState(false);
  const [splitError, setSplitError] = useState<string | null>(null);
  const [splitBlocked, setSplitBlocked] = useState<BlockedVendorOffer[] | null>(null);
  const brandsForSplit = useFetch<BrandRow[]>(panel === "split" ? "/brands" : null);
  const categoriesForSplit = useFetch<CategoryRow[]>(panel === "split" ? "/categories" : null);

  function toggleSplitVariant(id: string) {
    setSplitVariantIds((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
  }

  async function submitSplit() {
    if (splitVariantIds.length === 0 || !splitBrandId || !splitCategoryId || !splitModelName.trim()) return;
    setSplitBusy(true);
    setSplitError(null);
    setSplitBlocked(null);
    try {
      await apiFetch(`/canonical-products/${params.id}/split`, {
        method: "POST",
        body: {
          variant_ids: splitVariantIds,
          brand_id: splitBrandId,
          category_id: splitCategoryId,
          model_name: splitModelName.trim(),
        },
        idempotencyKey: newIdempotencyKey("canonical-product-split"),
      });
      setNotice("تم تقسيم المنتج بنجاح");
      setPanel("none");
      setSplitVariantIds([]);
      setSplitBrandId("");
      setSplitCategoryId("");
      setSplitModelName("");
      reload();
    } catch (err) {
      if (err instanceof ApiError && err.code === "SPLIT_WOULD_SPAN_VENDOR_OFFER") {
        setSplitBlocked((err.details as BlockedVendorOffer[]) ?? []);
      } else {
        setSplitError(adminErrorMessage(err));
      }
    } finally {
      setSplitBusy(false);
    }
  }

  if (gate.status === "loading") {
    return (
      <div className="page-shell">
        <div className="skeleton" style={{ height: 160, width: "100%", maxWidth: 800 }} />
      </div>
    );
  }
  if (gate.status === "forbidden" || detail.status === 403) {
    return (
      <div className="page-shell">
        <EmptyState title="هذه الصفحة لمدير المنصة فقط" actionHref="/account" actionLabel="حسابي" />
      </div>
    );
  }
  if (detail.status === 404) {
    return (
      <div className="page-shell">
        <EmptyState title="المنتج المرجعي غير موجود" actionHref="/admin/canonical-products" actionLabel="قائمة المنتجات المرجعية" />
      </div>
    );
  }

  return (
    <div className="page-shell">
      <div className="wide-shell" style={{ maxWidth: 800 }}>
        <div className="top-bar">
          <h1 className="page-title" style={{ margin: 0 }}>
            {d ? d.canonical_name_ar ?? d.model_name : "منتج مرجعي"}
          </h1>
          <Link href="/admin/canonical-products" className="button-link">قائمة المنتجات المرجعية</Link>
        </div>

        {detail.error && <ErrorBanner message={detail.error} />}
        {notice && <div className="notice-banner" role="status">{notice}</div>}
        {actionError && <ErrorBanner message={actionError} />}
        {detail.loading && !d && (
          <div aria-busy="true" aria-label="جارٍ التحميل">
            <div className="skeleton" style={{ height: 160, width: "100%" }} />
          </div>
        )}

        {d && (
          <>
            <div className="card" style={{ maxWidth: "none", marginBottom: 14 }}>
              <p>
                <span className={`badge${d.status === "PUBLISHED" ? " badge-active" : ""}`}>
                  {CANONICAL_PRODUCT_STATUS_LABEL[d.status] ?? d.status}
                </span>{" "}
                {d.is_restricted && <span className="badge">مقيَّد</span>}
              </p>

              {d.status === "MERGED" ? (
                <div className="warning-banner">
                  تم دمجه في منتج آخر.{" "}
                  {d.merged_into_id && (
                    <Link href={`/admin/canonical-products/${d.merged_into_id}`}>عرض المنتج الناجي</Link>
                  )}
                </div>
              ) : (
                <>
                  <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 10 }}>
                    {TRANSITIONS[d.status].map((t) => (
                      <button key={t.to} className="button" disabled={busy} onClick={() => transition(t.to)}>
                        {t.label}
                      </button>
                    ))}
                  </div>

                  {panel === "none" && (
                    <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                      {d.is_restricted ? (
                        <button className="button-link" onClick={() => openPanel("unrestrict")}>إلغاء التقييد</button>
                      ) : (
                        <button className="button-link" onClick={() => openPanel("restrict")}>تقييد</button>
                      )}
                      <button className="button-link" onClick={() => openPanel("merge")}>دمج هذا المنتج في...</button>
                      <button className="button-link" onClick={() => openPanel("split")}>تقسيم هذا المنتج</button>
                    </div>
                  )}

                  {(panel === "restrict" || panel === "unrestrict") && (
                    <div style={{ marginTop: 14 }}>
                      {panel === "restrict" ? (
                        <div className="field">
                          <label htmlFor="restrict-reason">سبب التقييد</label>
                          <textarea
                            id="restrict-reason"
                            rows={4}
                            value={reason}
                            disabled={busy}
                            onChange={(e) => setReason(e.target.value)}
                          />
                          <span className="muted">{reason.trim().length} / 1000</span>
                          {problem && reason.length > 0 && <span className="field-error">{problem}</span>}
                        </div>
                      ) : (
                        <p className="muted">هذا سيسمح بمطابقة عروض جديدة بهذا المنتج مجدداً.</p>
                      )}
                      <div style={{ display: "flex", gap: 8 }}>
                        <button
                          className="button"
                          disabled={busy || (panel === "restrict" && problem !== null)}
                          onClick={() => submitRestrict(panel === "restrict" ? "restrict" : "unrestrict")}
                        >
                          {busy ? "جارٍ الإرسال..." : panel === "restrict" ? "تأكيد التقييد" : "تأكيد إلغاء التقييد"}
                        </button>
                        <button className="button-link" disabled={busy} onClick={() => setPanel("none")}>إلغاء</button>
                      </div>
                    </div>
                  )}

                  {panel === "merge" && (
                    <div style={{ marginTop: 14 }}>
                      <h3 style={{ marginTop: 0 }}>دمج هذا المنتج في منتج ناجٍ</h3>
                      <p className="muted">هذا المنتج (الحالي) سيصبح &quot;المدموج&quot;؛ اختاري المنتج الناجي الذي ستُنقل متغيّراته وعروضه إليه.</p>
                      {!mergeConfirming ? (
                        <>
                          <div className="field">
                            <label htmlFor="merge-search">بحث باسم الطراز</label>
                            <input
                              id="merge-search"
                              value={mergeQuery}
                              onChange={(e) => setMergeQuery(e.target.value)}
                              placeholder="ابحثي عن المنتج الناجي"
                            />
                          </div>
                          <div style={{ maxHeight: 220, overflowY: "auto", border: "1px solid var(--color-border)", borderRadius: 10, marginBottom: 10 }}>
                            {mergeCandidates.length === 0 && <p className="muted" style={{ padding: 10 }}>لا توجد نتائج</p>}
                            {mergeCandidates.map((p) => (
                              <label
                                key={p.id}
                                style={{ display: "flex", alignItems: "center", gap: 8, padding: "8px 10px", borderBottom: "1px solid var(--color-border)" }}
                              >
                                <input
                                  type="radio"
                                  name="merge-target"
                                  checked={mergeTargetId === p.id}
                                  onChange={() => setMergeTargetId(p.id)}
                                />
                                {p.canonical_name_ar ?? p.model_name}
                              </label>
                            ))}
                          </div>
                          {mergeError && <ErrorBanner message={mergeError} />}
                          <div style={{ display: "flex", gap: 8 }}>
                            <button className="button" disabled={!mergeTargetId} onClick={() => setMergeConfirming(true)}>
                              متابعة
                            </button>
                            <button className="button-link" onClick={() => setPanel("none")}>إلغاء</button>
                          </div>
                        </>
                      ) : (
                        <>
                          <div className="warning-banner">
                            سيُدمَج هذا المنتج نهائياً في المنتج المحدَّد: متغيّراته وعروض المتاجر المرتبطة به ستُنقل إليه.
                            هل تأكّدت؟
                          </div>
                          {mergeUnmatched && mergeUnmatched.length > 0 && (
                            <div className="error-banner" role="alert">
                              تعذّر الدمج: بعض المتغيّرات لا تقابلها متغيّرات في المنتج الناجي:
                              <ul style={{ margin: "6px 0 0", paddingInlineStart: 20 }}>
                                {mergeUnmatched.map((u) => (
                                  <li key={u.loser_variant_id}>
                                    متغيّر {u.loser_variant_id} — عدد التطابقات المحتملة: {u.match_count}
                                  </li>
                                ))}
                              </ul>
                            </div>
                          )}
                          {mergeError && <ErrorBanner message={mergeError} />}
                          <div style={{ display: "flex", gap: 8 }}>
                            <button className="button" disabled={mergeBusy} onClick={submitMerge}>
                              {mergeBusy ? "جارٍ الدمج..." : "تأكيد الدمج"}
                            </button>
                            <button className="button-link" disabled={mergeBusy} onClick={() => setMergeConfirming(false)}>
                              رجوع
                            </button>
                            <button className="button-link" disabled={mergeBusy} onClick={() => setPanel("none")}>
                              إلغاء
                            </button>
                          </div>
                        </>
                      )}
                    </div>
                  )}

                  {panel === "split" && (
                    <div style={{ marginTop: 14 }}>
                      <h3 style={{ marginTop: 0 }}>تقسيم هذا المنتج</h3>
                      <p className="muted">اختاري المتغيّرات التي ستُنقل إلى منتج مرجعي جديد، وعرّفي بيانات المنتج الجديد.</p>
                      <div style={{ marginBottom: 10 }}>
                        {d.variants.map((v) => (
                          <label key={v.id} style={{ display: "flex", alignItems: "center", gap: 8, padding: "6px 0" }}>
                            <input
                              type="checkbox"
                              checked={splitVariantIds.includes(v.id)}
                              onChange={() => toggleSplitVariant(v.id)}
                            />
                            {Object.entries(v.structural_attributes ?? {}).map(([k, val]) => `${k}: ${val}`).join("، ") || v.id}
                            {v.mpn && <span className="muted"> - MPN: {v.mpn}</span>}
                          </label>
                        ))}
                      </div>
                      <div className="form-row">
                        <div className="field">
                          <label htmlFor="split-brand">العلامة التجارية للمنتج الجديد</label>
                          <select id="split-brand" value={splitBrandId} onChange={(e) => setSplitBrandId(e.target.value)}>
                            <option value="">اختاري علامة تجارية</option>
                            {(brandsForSplit.data ?? []).map((b) => (
                              <option key={b.id} value={b.id}>{b.name}</option>
                            ))}
                          </select>
                        </div>
                        <div className="field">
                          <label htmlFor="split-category">التصنيف للمنتج الجديد</label>
                          <select id="split-category" value={splitCategoryId} onChange={(e) => setSplitCategoryId(e.target.value)}>
                            <option value="">اختاري تصنيفاً</option>
                            {(categoriesForSplit.data ?? []).map((c) => (
                              <option key={c.id} value={c.id}>{c.name_ar}</option>
                            ))}
                          </select>
                        </div>
                      </div>
                      <div className="field">
                        <label htmlFor="split-model">اسم الطراز للمنتج الجديد</label>
                        <input id="split-model" value={splitModelName} onChange={(e) => setSplitModelName(e.target.value)} />
                      </div>
                      {splitBlocked && splitBlocked.length > 0 && (
                        <div className="error-banner" role="alert">
                          تعذّر التقسيم: عروض متاجر مرتبطة بمتغيّرات ستُقسَّم بين منتجين مختلفين:
                          <ul style={{ margin: "6px 0 0", paddingInlineStart: 20 }}>
                            {splitBlocked.map((b) => (
                              <li key={b.vendor_offer_id}>عرض {b.vendor_offer_id}</li>
                            ))}
                          </ul>
                        </div>
                      )}
                      {splitError && <ErrorBanner message={splitError} />}
                      <div style={{ display: "flex", gap: 8 }}>
                        <button
                          className="button"
                          disabled={splitBusy || splitVariantIds.length === 0 || !splitBrandId || !splitCategoryId || !splitModelName.trim()}
                          onClick={submitSplit}
                        >
                          {splitBusy ? "جارٍ التقسيم..." : "تأكيد التقسيم"}
                        </button>
                        <button className="button-link" disabled={splitBusy} onClick={() => setPanel("none")}>إلغاء</button>
                      </div>
                    </div>
                  )}
                </>
              )}
            </div>

            {d.status !== "MERGED" && (
              <>
                <div className="card" style={{ maxWidth: "none", marginBottom: 14 }}>
                  <h3 style={{ marginTop: 0 }}>بيانات المنتج</h3>
                  <div className="field">
                    <label htmlFor="product-type">نوع المنتج</label>
                    <select id="product-type" value={productType} disabled={fieldsBusy} onChange={(e) => setProductType(e.target.value as ProductType)}>
                      {Object.entries(PRODUCT_TYPE_LABEL).map(([k, label]) => (
                        <option key={k} value={k}>{label}</option>
                      ))}
                    </select>
                  </div>
                  <div className="form-row">
                    <div className="field">
                      <label htmlFor="warranty-period">مدة الضمان</label>
                      <input id="warranty-period" type="number" value={warrantyPeriod} disabled={fieldsBusy} onChange={(e) => setWarrantyPeriod(e.target.value)} />
                    </div>
                    <div className="field">
                      <label htmlFor="warranty-type">نوع الضمان</label>
                      <input id="warranty-type" value={warrantyType} disabled={fieldsBusy} onChange={(e) => setWarrantyType(e.target.value)} />
                    </div>
                  </div>
                  <div className="field">
                    <label htmlFor="tags">الكلمات الدلالية (مفصولة بفواصل)</label>
                    <input id="tags" value={tagsText} disabled={fieldsBusy} onChange={(e) => setTagsText(e.target.value)} />
                  </div>
                  <div className="form-row">
                    <div className="field">
                      <label htmlFor="seo-title-ar">عنوان SEO بالعربية</label>
                      <input id="seo-title-ar" value={seoTitleAr} disabled={fieldsBusy} onChange={(e) => setSeoTitleAr(e.target.value)} />
                    </div>
                    <div className="field">
                      <label htmlFor="seo-title-en">عنوان SEO بالإنجليزية</label>
                      <input id="seo-title-en" value={seoTitleEn} disabled={fieldsBusy} onChange={(e) => setSeoTitleEn(e.target.value)} />
                    </div>
                  </div>
                  <div className="field">
                    <label htmlFor="seo-desc-ar">وصف SEO بالعربية</label>
                    <textarea id="seo-desc-ar" rows={3} value={seoDescAr} disabled={fieldsBusy} onChange={(e) => setSeoDescAr(e.target.value)} />
                  </div>
                  <div className="field">
                    <label htmlFor="seo-desc-en">وصف SEO بالإنجليزية</label>
                    <textarea id="seo-desc-en" rows={3} value={seoDescEn} disabled={fieldsBusy} onChange={(e) => setSeoDescEn(e.target.value)} />
                  </div>
                  {fieldsError && <ErrorBanner message={fieldsError} />}
                  {fieldsNotice && <p className="muted">{fieldsNotice}</p>}
                  <button className="button" disabled={fieldsBusy} onClick={saveFields}>
                    {fieldsBusy ? "جارٍ الحفظ..." : "حفظ"}
                  </button>
                </div>

                <div className="card" style={{ maxWidth: "none" }}>
                  <h3 style={{ marginTop: 0 }}>المتغيّرات</h3>
                  {d.variants.length === 0 ? (
                    <p className="muted">لا توجد متغيّرات لهذا المنتج بعد.</p>
                  ) : (
                    <ul style={{ margin: "0 0 14px", paddingInlineStart: 20 }}>
                      {d.variants.map((v) => (
                        <li key={v.id} style={{ marginBottom: 6 }}>
                          {Object.entries(v.structural_attributes ?? {}).map(([k, val]) => `${k}: ${val}`).join("، ") || "بلا خصائص"}
                          {v.mpn && <span className="muted"> - MPN: {v.mpn}</span>}
                          {v.gtin && <span className="muted"> - GTIN: {v.gtin}</span>}
                        </li>
                      ))}
                    </ul>
                  )}

                  <h4>إضافة متغيّر</h4>
                  {attrRows.map((row, i) => (
                    <div key={i} style={{ display: "flex", gap: 8, marginBottom: 8, flexWrap: "wrap" }}>
                      <input
                        placeholder="خاصية (مثل: اللون)"
                        value={row.key}
                        disabled={variantBusy}
                        onChange={(e) => updateAttrRow(i, "key", e.target.value)}
                        style={{ flex: 1, minWidth: 140 }}
                      />
                      <input
                        placeholder="القيمة"
                        value={row.value}
                        disabled={variantBusy}
                        onChange={(e) => updateAttrRow(i, "value", e.target.value)}
                        style={{ flex: 1, minWidth: 140 }}
                      />
                      <button
                        type="button"
                        className="button-link"
                        disabled={variantBusy || attrRows.length === 1}
                        onClick={() => setAttrRows((rows) => rows.filter((_, idx) => idx !== i))}
                      >
                        حذف
                      </button>
                    </div>
                  ))}
                  <button
                    type="button"
                    className="button-link"
                    disabled={variantBusy}
                    onClick={() => setAttrRows((rows) => [...rows, { key: "", value: "" }])}
                    style={{ marginBottom: 10 }}
                  >
                    + إضافة خاصية
                  </button>
                  <div className="form-row">
                    <div className="field">
                      <label htmlFor="variant-mpn">MPN (اختياري)</label>
                      <input id="variant-mpn" value={mpn} disabled={variantBusy} onChange={(e) => setMpn(e.target.value)} />
                    </div>
                    <div className="field">
                      <label htmlFor="variant-gtin">GTIN (اختياري)</label>
                      <input id="variant-gtin" value={gtin} disabled={variantBusy} onChange={(e) => setGtin(e.target.value)} />
                    </div>
                  </div>
                  {variantError && <ErrorBanner message={variantError} />}
                  <button className="button" disabled={variantBusy} onClick={addVariant}>
                    {variantBusy ? "جارٍ الإضافة..." : "إضافة متغيّر"}
                  </button>
                </div>
              </>
            )}
          </>
        )}
      </div>
    </div>
  );
}
