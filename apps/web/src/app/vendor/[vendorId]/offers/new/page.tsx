"use client";

import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { ErrorBanner } from "@/components/States";
import { apiFetch, ApiError, newIdempotencyKey } from "@/lib/api";
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
}

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
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!getSessionToken()) {
      router.replace("/login");
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

  async function save() {
    if (!titleAr.trim() || !titleEn.trim()) {
      setError("العنوان بالعربية والإنجليزية مطلوبان");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const body: Record<string, unknown> = {
        title_ar: titleAr.trim(),
        title_en: titleEn.trim(),
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
      setError(err instanceof ApiError ? err.message : "تعذّر إنشاء العرض");
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
          <label>العنوان بالإنجليزية</label>
          <input value={titleEn} onChange={(e) => setTitleEn(e.target.value)} />
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
