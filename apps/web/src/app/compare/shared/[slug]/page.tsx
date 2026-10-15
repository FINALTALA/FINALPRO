"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import SafeImage from "@/components/SafeImage";
import { EmptyState, ErrorBanner, SkeletonGrid } from "@/components/States";
import { useFetch } from "@/lib/useFetch";

interface SetItemDto {
  canonical_product_id: string;
  name_ar?: string;
  name_en?: string;
  brand_name?: string | null;
  category_name?: string | null;
  lowest_price?: string;
  image_url?: string | null;
  added_at: string;
  available: boolean;
}

interface SharedSetDto {
  share_slug: string;
  items: SetItemDto[];
}

// Sprint 24 (FR-COMP-007): the public, read-only share link - never
// session-guarded, never accepts/exposes the internal set id, only
// the opaque share_slug from the URL itself.
export default function SharedComparisonSetPage() {
  const params = useParams<{ slug: string }>();
  const shared = useFetch<SharedSetDto>(`/comparison-sets/shared/${params.slug}`, false);

  if (shared.error) {
    return (
      <div className="page-shell">
        <div className="wide-shell">
          {shared.status === 404 ? (
            <EmptyState title="رابط المشاركة غير صالح أو تم حذف المجموعة" actionHref="/" actionLabel="الصفحة الرئيسية" />
          ) : (
            <ErrorBanner message={shared.error} />
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="page-shell">
      <div className="wide-shell">
        <h1 className="page-title">مجموعة مقارنة مشتركة</h1>

        {shared.loading && <SkeletonGrid count={4} />}

        {shared.data && shared.data.items.length === 0 && (
          <EmptyState title="هذه المجموعة فارغة حالياً" />
        )}

        {shared.data && shared.data.items.length > 0 && (
          <div className="compare-grid">
            {shared.data.items.map((item) => (
              <div key={item.canonical_product_id} className="compare-card">
                {item.image_url && (
                  <SafeImage src={item.image_url} alt={item.name_ar ?? "منتج"} className="compare-thumb" />
                )}
                {item.available ? (
                  <>
                    <Link href={`/compare/${item.canonical_product_id}`}>
                      <strong>{item.name_ar ?? item.name_en}</strong>
                    </Link>
                    {item.lowest_price && (
                      <div className="product-card-price">{item.lowest_price} ₪</div>
                    )}
                  </>
                ) : (
                  <span className="muted">غير متوفر حالياً</span>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
