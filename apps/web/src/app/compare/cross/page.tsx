"use client";

import Link from "next/link";
import { useState } from "react";
import { ErrorBanner, SkeletonGrid } from "@/components/States";
import { AVAILABILITY_LABEL, Availability } from "@/lib/types";
import { useFetch } from "@/lib/useFetch";

const ZONES = [
  { value: "", label: "بدون تحديد منطقة" },
  { value: "WEST_BANK", label: "الضفة الغربية" },
  { value: "JERUSALEM", label: "القدس" },
  { value: "INSIDE", label: "الداخل" },
];

interface CrossProductDto {
  canonical_product_id: string;
  canonical_name_ar: string;
  canonical_name_en: string;
  brand_name: string | null;
  category_name: string | null;
  available: boolean;
  store_count?: number;
  price?: string;
  availability?: Availability;
  condition?: string;
  warranty_period?: string;
  warranty_type?: string;
  delivery_fee?: number | null;
  delivery_fee_status?: "NO_ZONE_SELECTED" | "AVAILABLE" | "NOT_AVAILABLE_IN_ZONE";
  rating?: number | null;
  rating_count?: number;
  is_price_stale?: boolean;
  is_cheapest?: boolean;
  cheapest_reason?: string;
}

interface DiffFieldDto {
  field: string;
  values: (string | number | boolean | null)[];
  all_same: boolean;
}

interface CrossComparisonDto {
  products: CrossProductDto[];
  diff: DiffFieldDto[];
}

const FIELD_LABEL: Record<string, string> = {
  condition: "الحالة",
  warranty_period: "مدة الضمان",
  warranty_type: "نوع الضمان",
};

// Sprint 24 (FR-COMP-002 mode 2, FR-COMP-004/005/006): comparing 2-4
// DIFFERENT, competing canonical products side by side - each
// product represented by its own cheapest eligible offer.
export default function CrossComparisonPage() {
  const [ids, setIds] = useState<string[]>(["", ""]);
  const [zone, setZone] = useState("");
  const [submitted, setSubmitted] = useState<{ ids: string[]; zone: string } | null>(null);

  const query = submitted
    ? (() => {
        const qs = new URLSearchParams({ products: submitted.ids.join(",") });
        if (submitted.zone) qs.set("zone", submitted.zone);
        return `/comparison/cross?${qs.toString()}`;
      })()
    : null;
  const result = useFetch<CrossComparisonDto>(query, false);

  function setId(index: number, value: string) {
    setIds((prev) => prev.map((v, i) => (i === index ? value : v)));
  }

  function addSlot() {
    if (ids.length < 4) setIds((prev) => [...prev, ""]);
  }

  function removeSlot(index: number) {
    if (ids.length > 2) setIds((prev) => prev.filter((_, i) => i !== index));
  }

  function submit() {
    const cleaned = ids.map((v) => v.trim()).filter(Boolean);
    if (cleaned.length < 2) return;
    setSubmitted({ ids: cleaned, zone });
  }

  return (
    <div className="page-shell">
      <div className="wide-shell">
        <h1 className="page-title">مقارنة منتجات منافسة</h1>
        <p className="page-subtitle">قارني بين 2 إلى 4 منتجات أساسية مختلفة، كل واحد بأرخص عرض مؤهّل له.</p>

        <div className="card" style={{ marginBottom: 20 }}>
          {ids.map((id, i) => (
            <div key={i} style={{ display: "flex", gap: 8, marginBottom: 8 }}>
              <input
                type="text"
                placeholder={`معرّف المنتج ${i + 1}`}
                value={id}
                onChange={(e) => setId(i, e.target.value)}
                style={{ flex: 1 }}
              />
              {ids.length > 2 && (
                <button className="button-link" onClick={() => removeSlot(i)}>حذف</button>
              )}
            </div>
          ))}
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
            {ids.length < 4 && (
              <button className="button-link" onClick={addSlot}>+ منتج آخر</button>
            )}
            <select value={zone} onChange={(e) => setZone(e.target.value)}>
              {ZONES.map((z) => (
                <option key={z.value} value={z.value}>{z.label}</option>
              ))}
            </select>
            <button className="button" onClick={submit}>قارني</button>
          </div>
        </div>

        {result.error && (
          <ErrorBanner message={result.status === 404 ? "أحد المنتجات غير موجود" : result.error} />
        )}
        {result.loading && <SkeletonGrid count={2} />}

        {result.data && (
          <>
            <div className="compare-grid">
              {result.data.products.map((p) => (
                <div key={p.canonical_product_id} className={`compare-card${p.is_cheapest ? " best" : ""}`}>
                  {p.is_cheapest && <span className="compare-rank">{p.cheapest_reason ?? "الأرخص"}</span>}
                  <Link href={`/compare/${p.canonical_product_id}`}>
                    <strong>{p.canonical_name_ar}</strong>
                  </Link>
                  {p.brand_name && <div className="muted">{p.brand_name}</div>}
                  {!p.available ? (
                    <span className="muted">لا توجد عروض مؤهلة لهذا المنتج</span>
                  ) : (
                    <>
                      <div className="product-card-price">{p.price} ₪</div>
                      {p.availability && (
                        <span className={`availability-badge availability-${p.availability}`}>
                          {AVAILABILITY_LABEL[p.availability]}
                        </span>
                      )}
                      {p.is_price_stale && (
                        <span className="muted" style={{ fontSize: 12 }}>⚠ بيانات السعر قديمة</span>
                      )}
                      {p.warranty_period && (
                        <div className="muted" style={{ fontSize: 13 }}>الضمان: {p.warranty_period}</div>
                      )}
                      {p.delivery_fee_status === "AVAILABLE" && (
                        <div className="muted" style={{ fontSize: 13 }}>رسوم التوصيل: {p.delivery_fee} ₪</div>
                      )}
                      {p.delivery_fee_status === "NOT_AVAILABLE_IN_ZONE" && (
                        <div className="muted" style={{ fontSize: 13 }}>لا توصيل لهذه المنطقة</div>
                      )}
                      {typeof p.rating === "number" && (
                        <div className="muted" style={{ fontSize: 13 }}>
                          التقييم: {p.rating.toFixed(1)} ({p.rating_count})
                        </div>
                      )}
                    </>
                  )}
                </div>
              ))}
            </div>

            {result.data.diff.some((d) => !d.all_same) && (
              <div className="card" style={{ marginTop: 16 }}>
                <strong style={{ display: "block", marginBottom: 8 }}>الفروقات</strong>
                {result.data.diff
                  .filter((d) => !d.all_same)
                  .map((d) => (
                    <div key={d.field} className="muted" style={{ fontSize: 13 }}>
                      {FIELD_LABEL[d.field] ?? d.field}: {d.values.map((v) => String(v ?? "غير متوفر")).join(" / ")}
                    </div>
                  ))}
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
