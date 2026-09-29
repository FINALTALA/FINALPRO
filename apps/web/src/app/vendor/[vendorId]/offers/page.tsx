"use client";

import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { EmptyState, ErrorBanner } from "@/components/States";
import { ApiError, apiFetch } from "@/lib/api";
import { clearSession, getSessionToken } from "@/lib/session";

interface OfferDto {
  id: string;
  title_ar: string;
  title_en: string;
  status: "DRAFT" | "ACTIVE" | "INACTIVE" | "ARCHIVED";
  canonical_product_id: string | null;
  brand_id: string | null;
}

const STATUS_LABEL: Record<OfferDto["status"], string> = {
  DRAFT: "مسودة",
  ACTIVE: "منشور",
  INACTIVE: "غير منشور",
  ARCHIVED: "مؤرشف",
};

// Sprint 13 (list) + Sprint 17 (owner catalog: create/edit/archive,
// PDR-036 templates, brand, media, pricing/discounts, import, matching)
// - the real, reachable catalog management UI. Backend authorization
// (VendorMembershipGuard + @RequireVendorRole('OWNER')) is the actual
// boundary; this page just hides owner-only actions from anyone else.
export default function OwnerOffersPage() {
  const params = useParams<{ vendorId: string }>();
  const router = useRouter();
  const [offers, setOffers] = useState<OfferDto[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  function load() {
    apiFetch<OfferDto[]>(`/vendors/${params.vendorId}/offers`)
      .then(setOffers)
      .catch((err) => {
        if (err instanceof ApiError && err.status === 401) {
          clearSession();
          router.replace("/login");
          return;
        }
        setError(err instanceof ApiError ? err.message : "تعذّر تحميل العروض");
      });
  }

  useEffect(() => {
    if (!getSessionToken()) {
      router.replace("/login");
      return;
    }
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [params.vendorId]);

  return (
    <div className="page-shell">
      <div className="top-bar">
        <h1 className="page-title" style={{ margin: 0 }}>المنتجات والعروض</h1>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <Link href={`/vendor/${params.vendorId}/offers/import`} className="button-link">
            استيراد ملف CSV/XLSX
          </Link>
          <Link href={`/vendor/${params.vendorId}/offers/new`} className="button">
            + عرض جديد
          </Link>
          <Link href={`/vendor/${params.vendorId}`} className="button-link">لوحة المتجر</Link>
        </div>
      </div>
      {error && <ErrorBanner message={error} />}
      {!offers && !error && <div className="skeleton" style={{ height: 120, width: "100%", maxWidth: 1240 }} />}
      {offers && offers.length === 0 && (
        <EmptyState
          title="لا توجد عروض بعد"
          message="أنشئ أول عرض لمتجرك."
          actionHref={`/vendor/${params.vendorId}/offers/new`}
          actionLabel="+ عرض جديد"
        />
      )}
      {offers && offers.length > 0 && (
        <div className="wide-shell" style={{ overflowX: "auto" }}>
          <table className="data-table">
            <thead>
              <tr>
                <th>العنوان</th>
                <th>الحالة</th>
                <th>العلامة التجارية</th>
                <th>مطابق لمنتج مرجعي</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {offers.map((o) => (
                <tr key={o.id}>
                  <td>{o.title_ar}</td>
                  <td>
                    <span className={`badge${o.status === "ACTIVE" ? " badge-active" : ""}`}>
                      {STATUS_LABEL[o.status]}
                    </span>
                  </td>
                  <td>{o.brand_id ? "محدّدة" : "—"}</td>
                  <td>{o.canonical_product_id ? "نعم" : "لا"}</td>
                  <td>
                    <Link href={`/vendor/${params.vendorId}/offers/${o.id}`} className="button-link">
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
  );
}
