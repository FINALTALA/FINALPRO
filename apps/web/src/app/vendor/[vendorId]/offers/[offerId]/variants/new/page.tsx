"use client";

import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { ErrorBanner } from "@/components/States";
import { apiFetch, ApiError, newIdempotencyKey } from "@/lib/api";
import { getSessionToken } from "@/lib/session";

interface VariantDto {
  id: string;
}

type PriceMode = "none" | "sale" | "discount";

// Sprint 17 (blocker 1): create a variant with the full pricing model -
// basePrice (required), an optional manual sale_price OR an optional
// scheduled relative discount (mutually exclusive - the form only lets
// one mode be filled in at a time).
export default function NewVariantPage() {
  const params = useParams<{ vendorId: string; offerId: string }>();
  const router = useRouter();
  const [sellerSku, setSellerSku] = useState("");
  const [basePrice, setBasePrice] = useState("");
  const [condition, setCondition] = useState("NEW");
  const [colour, setColour] = useState("");
  const [size, setSize] = useState("");
  const [priceMode, setPriceMode] = useState<PriceMode>("none");
  const [salePrice, setSalePrice] = useState("");
  const [discountPercent, setDiscountPercent] = useState("");
  const [discountStart, setDiscountStart] = useState("");
  const [discountEnd, setDiscountEnd] = useState("");
  const [identifierType, setIdentifierType] = useState("");
  const [identifierValue, setIdentifierValue] = useState("");
  const [specsAr, setSpecsAr] = useState("");
  const [specsEn, setSpecsEn] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!getSessionToken()) router.replace("/login");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function save() {
    const price = Number(basePrice);
    if (!sellerSku.trim() || !price || price <= 0) {
      setError("رمز المنتج وسعر الأساس مطلوبان");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const body: Record<string, unknown> = {
        seller_sku: sellerSku.trim(),
        base_price: price,
        condition,
      };
      if (colour.trim()) body.colour = colour.trim();
      if (size.trim()) body.size = size.trim();
      if (specsAr.trim()) body.specs_text_ar = specsAr.trim();
      if (specsEn.trim()) body.specs_text_en = specsEn.trim();
      if (identifierType && identifierValue.trim()) {
        body.identifier_type = identifierType;
        body.identifier_value = identifierValue.trim();
      }
      if (priceMode === "sale" && salePrice) {
        body.sale_price = Number(salePrice);
      } else if (priceMode === "discount" && discountPercent && discountStart && discountEnd) {
        body.discount_percent = Number(discountPercent);
        body.discount_start_at = new Date(discountStart).toISOString();
        body.discount_end_at = new Date(discountEnd).toISOString();
      }
      const created = await apiFetch<VariantDto>(
        `/vendors/${params.vendorId}/offers/${params.offerId}/variants`,
        { method: "POST", body, idempotencyKey: newIdempotencyKey("variant-create") },
      );
      router.push(`/vendor/${params.vendorId}/offers/${params.offerId}/variants/${created.id}`);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "تعذّر إنشاء المتغيّر");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="page-shell">
      <div className="top-bar">
        <h1 className="page-title" style={{ margin: 0 }}>متغيّر جديد</h1>
        <Link href={`/vendor/${params.vendorId}/offers/${params.offerId}`} className="button-link">
          العودة للعرض
        </Link>
      </div>
      {error && <ErrorBanner message={error} />}
      <div className="card" style={{ maxWidth: 560 }}>
        <div className="field">
          <label>رمز المنتج (SKU)</label>
          <input value={sellerSku} onChange={(e) => setSellerSku(e.target.value)} />
        </div>
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
          <label>اللون (اختياري)</label>
          <input value={colour} onChange={(e) => setColour(e.target.value)} />
        </div>
        <div className="field">
          <label>المقاس (اختياري)</label>
          <input value={size} onChange={(e) => setSize(e.target.value)} />
        </div>

        <div className="field">
          <label>نمط السعر</label>
          <select value={priceMode} onChange={(e) => setPriceMode(e.target.value as PriceMode)}>
            <option value="none">بدون تخفيض</option>
            <option value="sale">سعر مخفّض ثابت</option>
            <option value="discount">خصم مجدوَل (يبدأ/ينتهي)</option>
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
                value={discountStart}
                onChange={(e) => setDiscountStart(e.target.value)}
              />
            </div>
            <div className="field">
              <label>نهاية الخصم</label>
              <input
                type="datetime-local"
                value={discountEnd}
                onChange={(e) => setDiscountEnd(e.target.value)}
              />
            </div>
          </>
        )}

        <div className="field">
          <label>نوع المعرّف الدولي (اختياري - للمطابقة مع منتج مرجعي)</label>
          <select value={identifierType} onChange={(e) => setIdentifierType(e.target.value)}>
            <option value="">— بدون —</option>
            <option value="GTIN">GTIN</option>
            <option value="EAN">EAN</option>
            <option value="UPC">UPC</option>
            <option value="ISBN">ISBN</option>
            <option value="MPN">MPN</option>
          </select>
        </div>
        {identifierType && (
          <div className="field">
            <label>قيمة المعرّف</label>
            <input value={identifierValue} onChange={(e) => setIdentifierValue(e.target.value)} />
          </div>
        )}

        <div className="field">
          <label>مواصفات نصّية بالعربية (اختياري)</label>
          <input value={specsAr} onChange={(e) => setSpecsAr(e.target.value)} />
        </div>
        <div className="field">
          <label>مواصفات نصّية بالإنجليزية (اختياري)</label>
          <input value={specsEn} onChange={(e) => setSpecsEn(e.target.value)} />
        </div>

        <button className="button" onClick={save} disabled={saving}>
          إنشاء المتغيّر
        </button>
      </div>
    </div>
  );
}
