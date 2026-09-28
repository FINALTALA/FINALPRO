"use client";

import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { ErrorBanner } from "@/components/States";
import { apiFetch, ApiError } from "@/lib/api";
import { getSessionToken } from "@/lib/session";
import {
  ALL_CLOTHING_TEMPLATES,
  CLOTHING_CATEGORY_TEMPLATE_FIELDS,
  CLOTHING_CATEGORY_TEMPLATE_LABELS,
  ClothingCategoryTemplate,
  templateFieldLabel,
} from "@/lib/clothingTemplates";

interface BrandDto {
  id: string;
  name: string;
}

interface OfferDto {
  id: string;
  title_ar: string;
  title_en: string;
  status: "DRAFT" | "ACTIVE" | "INACTIVE" | "ARCHIVED";
  brand_id: string | null;
  category_template: ClothingCategoryTemplate | null;
  template_attributes: Record<string, string> | null;
  canonical_product_id: string | null;
  archived_at: string | null;
}

interface VariantDto {
  id: string;
  seller_sku: string;
  base_price: string;
  sale_price: string | null;
  discount_percent: string | null;
  effective_price: number;
  colour: string | null;
  size: string | null;
  match_proposal_status: "NONE" | "PENDING" | "CONFIRMED" | "REJECTED";
}

const STATUS_LABEL: Record<OfferDto["status"], string> = {
  DRAFT: "مسودة",
  ACTIVE: "منشور",
  INACTIVE: "غير منشور",
  ARCHIVED: "مؤرشف",
};

const MATCH_LABEL: Record<VariantDto["match_proposal_status"], string> = {
  NONE: "غير مطابق",
  PENDING: "تطابق مقترح - بانتظار القرار",
  CONFIRMED: "مؤكد المطابقة",
  REJECTED: "تم رفض التطابق",
};

// Sprint 17 (blocker 2): the owner's real offer edit page - title,
// brand, PDR-036 template, status transitions (with the publish gate's
// exact reasons on refusal), archive/restore, and the variant list.
export default function OfferDetailPage() {
  const params = useParams<{ vendorId: string; offerId: string }>();
  const router = useRouter();
  const [offer, setOffer] = useState<OfferDto | null>(null);
  const [variants, setVariants] = useState<VariantDto[] | null>(null);
  const [brands, setBrands] = useState<BrandDto[] | null>(null);
  const [titleAr, setTitleAr] = useState("");
  const [titleEn, setTitleEn] = useState("");
  const [brandId, setBrandId] = useState("");
  const [template, setTemplate] = useState<ClothingCategoryTemplate | "">("");
  const [attrs, setAttrs] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  function load() {
    apiFetch<OfferDto>(`/vendors/${params.vendorId}/offers/${params.offerId}`)
      .then((o) => {
        setOffer(o);
        setTitleAr(o.title_ar);
        setTitleEn(o.title_en);
        setBrandId(o.brand_id ?? "");
        setTemplate(o.category_template ?? "");
        setAttrs(o.template_attributes ?? {});
      })
      .catch((err) => setError(err instanceof ApiError ? err.message : "تعذّر تحميل العرض"));
    apiFetch<VariantDto[]>(`/vendors/${params.vendorId}/offers/${params.offerId}/variants`)
      .then(setVariants)
      .catch(() => {});
  }

  useEffect(() => {
    if (!getSessionToken()) {
      router.replace("/login");
      return;
    }
    load();
    apiFetch<BrandDto[]>("/brands", { auth: false })
      .then(setBrands)
      .catch(() => setBrands([]));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [params.vendorId, params.offerId]);

  const identityLocked = !!offer?.canonical_product_id;

  function setAttr(key: string, value: string) {
    setAttrs((prev) => ({ ...prev, [key]: value }));
  }

  async function save() {
    if (!offer) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const body: Record<string, unknown> = {};
      if (titleAr.trim() !== offer.title_ar) body.title_ar = titleAr.trim();
      if (titleEn.trim() !== offer.title_en) body.title_en = titleEn.trim();
      if (brandId !== (offer.brand_id ?? "")) body.brand_id = brandId || null;
      if (template !== (offer.category_template ?? "")) {
        body.category_template = template || null;
        body.template_attributes = template
          ? Object.fromEntries(
              CLOTHING_CATEGORY_TEMPLATE_FIELDS[template as ClothingCategoryTemplate].map((k) => [
                k,
                attrs[k] ?? "",
              ]),
            )
          : null;
      } else if (template) {
        body.template_attributes = Object.fromEntries(
          CLOTHING_CATEGORY_TEMPLATE_FIELDS[template].map((k) => [k, attrs[k] ?? ""]),
        );
      }
      if (Object.keys(body).length === 0) {
        setNotice("لا توجد تغييرات للحفظ");
        return;
      }
      const updated = await apiFetch<OfferDto>(
        `/vendors/${params.vendorId}/offers/${params.offerId}`,
        { method: "PUT", body },
      );
      setOffer(updated);
      setNotice("تم حفظ التغييرات");
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "تعذّر حفظ التغييرات");
    } finally {
      setBusy(false);
    }
  }

  async function setStatus(status: "ACTIVE" | "INACTIVE") {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const updated = await apiFetch<OfferDto>(
        `/vendors/${params.vendorId}/offers/${params.offerId}/status`,
        { method: "PATCH", body: { status } },
      );
      setOffer(updated);
      setNotice(status === "ACTIVE" ? "تم نشر العرض" : "تم إيقاف نشر العرض");
    } catch (err) {
      if (err instanceof ApiError && err.code === "OFFER_NOT_PUBLISHABLE") {
        const reasons = err.details.map((d) => String(d));
        setError(`لا يمكن نشر العرض بعد. الناقص: ${reasons.join("، ")}`);
      } else {
        setError(err instanceof ApiError ? err.message : "تعذّر تغيير الحالة");
      }
    } finally {
      setBusy(false);
    }
  }

  async function archive() {
    setBusy(true);
    setError(null);
    try {
      const updated = await apiFetch<OfferDto>(
        `/vendors/${params.vendorId}/offers/${params.offerId}/archive`,
        { method: "POST" },
      );
      setOffer(updated);
      setNotice("تم أرشفة العرض");
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "تعذّر الأرشفة");
    } finally {
      setBusy(false);
    }
  }

  async function restore() {
    setBusy(true);
    setError(null);
    try {
      const updated = await apiFetch<OfferDto>(
        `/vendors/${params.vendorId}/offers/${params.offerId}/restore`,
        { method: "POST" },
      );
      setOffer(updated);
      setNotice("تمت الاستعادة كمسودة - راجعي بيانات النشر قبل إعادة النشر");
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "تعذّر الاستعادة");
    } finally {
      setBusy(false);
    }
  }

  if (!offer) {
    return (
      <div className="page-shell">
        {error ? <ErrorBanner message={error} /> : <p className="muted">جارٍ التحميل...</p>}
      </div>
    );
  }

  return (
    <div className="page-shell">
      <div className="top-bar">
        <div>
          <h1 className="page-title" style={{ margin: 0 }}>{offer.title_ar}</h1>
          <span className={`badge${offer.status === "ACTIVE" ? " badge-active" : ""}`}>
            {STATUS_LABEL[offer.status]}
          </span>
        </div>
        <Link href={`/vendor/${params.vendorId}/offers`} className="button-link">
          العودة للقائمة
        </Link>
      </div>

      {error && <ErrorBanner message={error} />}
      {notice && <p className="muted">{notice}</p>}

      <div className="card" style={{ maxWidth: 560 }}>
        <h3 style={{ marginTop: 0 }}>بيانات العرض</h3>
        {identityLocked && (
          <p className="muted">
            هذا العرض مطابق لمنتج مرجعي - لا يمكن تعديل العلامة التجارية أو قالب الفئة حتى يتوفر مسار إلغاء
            المطابقة.
          </p>
        )}
        <div className="field">
          <label>العنوان بالعربية</label>
          <input value={titleAr} onChange={(e) => setTitleAr(e.target.value)} />
        </div>
        <div className="field">
          <label>العنوان بالإنجليزية</label>
          <input value={titleEn} onChange={(e) => setTitleEn(e.target.value)} />
        </div>
        <div className="field">
          <label>العلامة التجارية</label>
          <select value={brandId} onChange={(e) => setBrandId(e.target.value)} disabled={identityLocked}>
            <option value="">— بدون تحديد —</option>
            {(brands ?? []).map((b) => (
              <option key={b.id} value={b.id}>
                {b.name}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label>قالب الفئة</label>
          <select
            value={template}
            onChange={(e) => {
              setTemplate(e.target.value as ClothingCategoryTemplate | "");
              setAttrs({});
            }}
            disabled={identityLocked}
          >
            <option value="">— بلا قالب (نص حر) —</option>
            {ALL_CLOTHING_TEMPLATES.map((t) => (
              <option key={t} value={t}>
                {CLOTHING_CATEGORY_TEMPLATE_LABELS[t]}
              </option>
            ))}
          </select>
        </div>
        {template && (
          <div className="card" style={{ background: "var(--bg-2, #f7f7f9)" }}>
            {CLOTHING_CATEGORY_TEMPLATE_FIELDS[template].map((key) => (
              <div className="field" key={key}>
                <label>{templateFieldLabel(key)}</label>
                <input
                  value={attrs[key] ?? ""}
                  onChange={(e) => setAttr(key, e.target.value)}
                  disabled={identityLocked}
                  placeholder='اكتب القيمة أو "N/A"'
                />
              </div>
            ))}
          </div>
        )}
        <button className="button" onClick={save} disabled={busy}>
          حفظ التغييرات
        </button>
      </div>

      <div className="card" style={{ maxWidth: 560, marginTop: 16 }}>
        <h3 style={{ marginTop: 0 }}>حالة النشر</h3>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          {offer.status !== "ARCHIVED" && offer.status !== "ACTIVE" && (
            <button className="button" onClick={() => setStatus("ACTIVE")} disabled={busy}>
              نشر
            </button>
          )}
          {offer.status === "ACTIVE" && (
            <button className="button" onClick={() => setStatus("INACTIVE")} disabled={busy}>
              إيقاف النشر
            </button>
          )}
          {(offer.status === "ACTIVE" || offer.status === "INACTIVE") && (
            <button className="button-link" onClick={archive} disabled={busy}>
              أرشفة
            </button>
          )}
          {offer.status === "ARCHIVED" && (
            <button className="button" onClick={restore} disabled={busy}>
              استعادة كمسودة
            </button>
          )}
        </div>
      </div>

      <div className="wide-shell" style={{ marginTop: 16 }}>
        <div className="top-bar">
          <h3 style={{ margin: 0 }}>المتغيّرات (الألوان/المقاسات/الأسعار)</h3>
          <Link href={`/vendor/${params.vendorId}/offers/${params.offerId}/variants/new`} className="button">
            + إضافة متغيّر
          </Link>
        </div>
        {variants && variants.length === 0 && (
          <p className="muted">لا توجد متغيّرات بعد - أضيفي واحدًا على الأقل قبل النشر.</p>
        )}
        {variants && variants.length > 0 && (
          <div style={{ overflowX: "auto" }}>
            <table className="data-table">
              <thead>
                <tr>
                  <th>رمز المنتج</th>
                  <th>اللون/المقاس</th>
                  <th>السعر الحالي</th>
                  <th>المطابقة</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {variants.map((v) => (
                  <tr key={v.id}>
                    <td>{v.seller_sku}</td>
                    <td>{[v.colour, v.size].filter(Boolean).join(" / ") || "—"}</td>
                    <td>{v.effective_price.toFixed(2)} ₪</td>
                    <td>{MATCH_LABEL[v.match_proposal_status]}</td>
                    <td>
                      <Link
                        href={`/vendor/${params.vendorId}/offers/${params.offerId}/variants/${v.id}`}
                        className="button-link"
                      >
                        فتح
                      </Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
