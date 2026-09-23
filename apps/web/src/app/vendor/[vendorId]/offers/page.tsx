"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { useState } from "react";
import { EmptyState, ErrorBanner } from "@/components/States";
import { ApiError, apiFetch } from "@/lib/api";
import { useFetch } from "@/lib/useFetch";

interface OfferDto {
  id: string;
  title_ar: string;
  title_en: string;
  status: "DRAFT" | "ACTIVE" | "INACTIVE";
  canonical_product_id: string | null;
}

const STATUS_LABEL: Record<OfferDto["status"], string> = {
  DRAFT: "مسودة",
  ACTIVE: "منشور",
  INACTIVE: "غير منشور",
};

// Sprint 13: the owner's product/offer list - read-only listing of
// GET /vendors/:vendorId/offers plus the existing status action
// (PATCH .../status). Creating offers, variants, matching and import
// remain API-only (unchanged). Owner-only server-side
// (@RequireVendorRole('OWNER')).
export default function OwnerOffersPage() {
  const params = useParams<{ vendorId: string }>();
  const offers = useFetch<OfferDto[]>(`/vendors/${params.vendorId}/offers`, true);
  const [overrides, setOverrides] = useState<Record<string, OfferDto["status"]>>({});
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function setStatus(offer: OfferDto, status: OfferDto["status"]) {
    setBusyId(offer.id);
    setError(null);
    try {
      await apiFetch(`/vendors/${params.vendorId}/offers/${offer.id}/status`, {
        method: "PATCH",
        body: { status },
      });
      setOverrides((prev) => ({ ...prev, [offer.id]: status }));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "تعذّر تغيير الحالة");
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div className="page-shell">
      <div className="top-bar">
        <h1 className="page-title" style={{ margin: 0 }}>المنتجات والعروض</h1>
        <Link href={`/vendor/${params.vendorId}`} className="button-link">لوحة المتجر</Link>
      </div>
      {error && <ErrorBanner message={error} />}
      {offers.error && <ErrorBanner message={offers.error} />}
      {offers.loading && <div className="skeleton" style={{ height: 120, width: "100%", maxWidth: 1240 }} />}
      {offers.data && offers.data.length === 0 && (
        <EmptyState title="لا توجد عروض بعد" message="تُنشأ العروض عبر واجهة البرمجة أو الاستيراد." />
      )}
      {offers.data && offers.data.length > 0 && (
        <div className="wide-shell" style={{ overflowX: "auto" }}>
          <table className="data-table">
            <thead>
              <tr>
                <th>العنوان</th>
                <th>الحالة</th>
                <th>مطابق لمنتج مرجعي</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {offers.data.map((o) => {
                const status = overrides[o.id] ?? o.status;
                return (
                  <tr key={o.id}>
                    <td>{o.title_ar}</td>
                    <td>
                      <span className={`badge${status === "ACTIVE" ? " badge-active" : ""}`}>{STATUS_LABEL[status]}</span>
                    </td>
                    <td>{o.canonical_product_id ? "نعم" : "لا"}</td>
                    <td>
                      {status === "ACTIVE" ? (
                        <button className="button-link" disabled={busyId === o.id} onClick={() => setStatus(o, "INACTIVE")}>
                          إيقاف النشر
                        </button>
                      ) : (
                        <button className="button-link" disabled={busyId === o.id} onClick={() => setStatus(o, "ACTIVE")}>
                          نشر
                        </button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
