"use client";

import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { ErrorBanner } from "@/components/States";
import { apiFetch, ApiError, newIdempotencyKey } from "@/lib/api";
import { getSessionToken } from "@/lib/session";
import { registerTranslations } from "@/lib/i18n";
import { useTaxonomy } from "@/lib/taxonomy";
import { useLang, useT } from "@/lib/useLang";
import { loginRedirectHref } from "@/lib/loginRedirect";
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
}

type Audience = "WOMEN" | "MEN" | "KIDS";
const AUDIENCES: Audience[] = ["WOMEN", "MEN", "KIDS"];

// The API classifies every new product (audience + category, Sprint 27) and
// refuses one without them; these two fields send exactly that. The API's
// own check stays the authority - this is only the form's early check, in
// the interface language.
registerTranslations({
  ar: {
    "newoffer.audience": "الفئة المستهدفة",
    "newoffer.audience.WOMEN": "نساء",
    "newoffer.audience.MEN": "رجال",
    "newoffer.audience.KIDS": "أطفال",
    "newoffer.audience.required": "اختاري الفئة المستهدفة: نساء أو رجال أو أطفال.",
    "newoffer.category": "فئة المنتج",
    "newoffer.category.placeholder": "— اختاري فئة المنتج —",
    "newoffer.category.pick_audience_first": "اختاري الفئة المستهدفة أولاً",
    "newoffer.category.required": "اختاري فئة المنتج.",
    "newoffer.category.not_in_audience": "هذه الفئة لا تناسب الفئة المستهدفة المختارة.",
    "newoffer.category.load_failed": "تعذّر تحميل فئات المنتجات. أعيدي المحاولة.",
  },
  en: {
    "newoffer.audience": "Target audience",
    "newoffer.audience.WOMEN": "Women",
    "newoffer.audience.MEN": "Men",
    "newoffer.audience.KIDS": "Kids",
    "newoffer.audience.required": "Choose the target audience: women, men or kids.",
    "newoffer.category": "Product category",
    "newoffer.category.placeholder": "— Choose the product category —",
    "newoffer.category.pick_audience_first": "Choose the target audience first",
    "newoffer.category.required": "Choose the product category.",
    "newoffer.category.not_in_audience": "This category doesn't fit the chosen audience.",
    "newoffer.category.load_failed": "Couldn't load the product categories. Try again.",
  },
});

// Sprint 17 (PDR-036, D1/D3): create an offer. Every structural field
// is optional here (the publish gate is the sole enforcement point -
// see the API's own vendor-offers.controller.ts) so a DRAFT with
// partial data is always allowed to save.
export default function NewOfferPage() {
  const params = useParams<{ vendorId: string }>();
  const router = useRouter();
  const [brands, setBrands] = useState<BrandDto[] | null>(null);
  const [titleAr, setTitleAr] = useState("");
  const [titleEn, setTitleEn] = useState("");
  const [brandId, setBrandId] = useState("");
  const [template, setTemplate] = useState<ClothingCategoryTemplate | "">("");
  const [attrs, setAttrs] = useState<Record<string, string>>({});
  const [audience, setAudience] = useState<Audience | "">("");
  const [category, setCategory] = useState("");
  const [fieldErrors, setFieldErrors] = useState<{ audience?: string; category?: string }>({});
  const taxonomy = useTaxonomy();
  const lang = useLang();
  const t = useT();
  const categories = (taxonomy.data?.categories ?? [])
    .filter((c) => audience !== "" && c.audiences.includes(audience))
    .sort((a, b) => a.sort_order - b.sort_order);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!getSessionToken()) {
      router.replace(loginRedirectHref());
      return;
    }
    apiFetch<BrandDto[]>("/brands", { auth: false })
      .then(setBrands)
      .catch(() => setBrands([]));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function setAttr(key: string, value: string) {
    setAttrs((prev) => ({ ...prev, [key]: value }));
  }

  function chooseAudience(next: Audience) {
    setAudience(next);
    setFieldErrors((prev) => ({ ...prev, audience: undefined }));
    // Keep the category only if it belongs to the new audience.
    const fits = (taxonomy.data?.categories ?? []).some((c) => c.code === category && c.audiences.includes(next));
    if (!fits) setCategory("");
  }

  async function save() {
    const missing: { audience?: string; category?: string } = {};
    if (!audience) missing.audience = "newoffer.audience.required";
    if (!category) missing.category = "newoffer.category.required";
    setFieldErrors(missing);
    // Phase A+: one required title (Arabic); the English name is optional.
    if (!titleAr.trim()) {
      setError("العنوان بالعربية مطلوب");
      return;
    }
    if (missing.audience || missing.category) {
      setError(null);
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const body: Record<string, unknown> = {
        title_ar: titleAr.trim(),
        title_en: titleEn.trim(),
        audiences: [audience],
        categories: [category],
      };
      if (brandId) body.brand_id = brandId;
      if (template) {
        body.category_template = template;
        body.template_attributes = Object.fromEntries(
          CLOTHING_CATEGORY_TEMPLATE_FIELDS[template].map((k) => [k, attrs[k] ?? ""]),
        );
      }
      const created = await apiFetch<OfferDto>(`/vendors/${params.vendorId}/offers`, {
        method: "POST",
        body,
        idempotencyKey: newIdempotencyKey("offer-create"),
      });
      router.push(`/vendor/${params.vendorId}/offers/${created.id}`);
    } catch (err) {
      // The classification refusals belong to their fields, in the page's words.
      if (err instanceof ApiError && err.code === "AUDIENCE_REQUIRED") {
        setFieldErrors({ audience: "newoffer.audience.required" });
      } else if (err instanceof ApiError && (err.code === "CATEGORY_REQUIRED" || err.code === "UNKNOWN_CATEGORY")) {
        setFieldErrors({ category: "newoffer.category.required" });
      } else if (err instanceof ApiError && err.code === "CATEGORY_NOT_IN_AUDIENCE") {
        setFieldErrors({ category: "newoffer.category.not_in_audience" });
      } else {
        setError(err instanceof ApiError ? err.message : "تعذّر إنشاء العرض");
      }
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="page-shell">
      <div className="top-bar">
        <h1 className="page-title" style={{ margin: 0 }}>عرض جديد</h1>
        <Link href={`/vendor/${params.vendorId}/offers`} className="button-link">
          العودة للقائمة
        </Link>
      </div>
      {error && <ErrorBanner message={error} />}
      <div className="card" style={{ maxWidth: 560 }}>
        <div className="field">
          <label>العنوان بالعربية</label>
          <input value={titleAr} onChange={(e) => setTitleAr(e.target.value)} />
        </div>
        <div className="field">
          <label>العنوان بالإنجليزية (اختياري)</label>
          <input value={titleEn} onChange={(e) => setTitleEn(e.target.value)} />
        </div>
        <fieldset className="field" style={{ border: 0, padding: 0, margin: 0 }} aria-describedby={fieldErrors.audience ? "newoffer-audience-error" : undefined}>
          <legend style={{ fontWeight: 600, marginBottom: 6 }}>
            {t("newoffer.audience")} <span aria-hidden="true">*</span>
          </legend>
          <div style={{ display: "flex", gap: 16, flexWrap: "wrap" }} role="radiogroup" aria-required="true" data-testid="newoffer-audience">
            {AUDIENCES.map((a) => (
              <label key={a} style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
                <input type="radio" name="audience" value={a} checked={audience === a} onChange={() => chooseAudience(a)} />
                {t(`newoffer.audience.${a}`)}
              </label>
            ))}
          </div>
          {fieldErrors.audience && (
            <p id="newoffer-audience-error" className="newoffer-field-error" role="alert" data-testid="newoffer-audience-error">
              {t(fieldErrors.audience)}
            </p>
          )}
        </fieldset>
        <div className="field">
          <label htmlFor="newoffer-category">
            {t("newoffer.category")} <span aria-hidden="true">*</span>
          </label>
          <select
            id="newoffer-category"
            data-testid="newoffer-category"
            value={category}
            disabled={!audience || taxonomy.status !== "ready"}
            aria-required="true"
            aria-describedby={fieldErrors.category ? "newoffer-category-error" : undefined}
            onChange={(e) => {
              setCategory(e.target.value);
              setFieldErrors((prev) => ({ ...prev, category: undefined }));
            }}
          >
            <option value="">{audience ? t("newoffer.category.placeholder") : t("newoffer.category.pick_audience_first")}</option>
            {categories.map((c) => (
              <option key={c.code} value={c.code}>
                {lang === "en" ? c.name_en || c.name_ar : c.name_ar}
              </option>
            ))}
          </select>
          {taxonomy.status === "error" && <p className="newoffer-field-error">{t("newoffer.category.load_failed")}</p>}
          {fieldErrors.category && (
            <p id="newoffer-category-error" className="newoffer-field-error" role="alert" data-testid="newoffer-category-error">
              {t(fieldErrors.category)}
            </p>
          )}
        </div>
        <div className="field">
          <label>العلامة التجارية (اختياري)</label>
          <select value={brandId} onChange={(e) => setBrandId(e.target.value)}>
            <option value="">— بدون تحديد الآن —</option>
            {(brands ?? []).map((b) => (
              <option key={b.id} value={b.id}>
                {b.name}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label>قالب الفئة (للملابس والإكسسوارات، اختياري)</label>
          <select
            value={template}
            onChange={(e) => {
              setTemplate(e.target.value as ClothingCategoryTemplate | "");
              setAttrs({});
            }}
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
                  placeholder='اكتب القيمة أو "N/A"'
                />
              </div>
            ))}
          </div>
        )}
        <button className="button" onClick={save} disabled={saving}>
          إنشاء العرض
        </button>
      </div>
    </div>
  );
}
