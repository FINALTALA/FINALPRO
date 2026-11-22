"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import SafeImage from "@/components/SafeImage";
import { EmptyState, ErrorBanner, SkeletonGrid } from "@/components/States";
import { useFetch } from "@/lib/useFetch";
import { translate } from "@/lib/i18n";
import { useLang } from "@/lib/useLang";
import { apiErrorMessage } from "@/lib/apiErrors";
import { pickText } from "@/lib/localized";
import "@/lib/compareSetsText";

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
  const lang = useLang();
  const t = (key: string) => translate(lang, key);
  const params = useParams<{ slug: string }>();
  const shared = useFetch<SharedSetDto>(`/comparison-sets/shared/${params.slug}`, false);

  if (shared.error) {
    return (
      <div className="page-shell">
        <div className="wide-shell">
          {shared.status === 404 ? (
            <EmptyState title={t("cset.shared_invalid")} actionHref="/" actionLabel={t("cset.home")} />
          ) : (
            <ErrorBanner message={apiErrorMessage(shared.apiError, lang)} />
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="page-shell">
      <div className="wide-shell">
        <h1 className="page-title">{t("cset.shared_title")}</h1>

        {shared.loading && <SkeletonGrid count={4} />}

        {shared.data && shared.data.items.length === 0 && (
          <EmptyState title={t("cset.shared_empty")} />
        )}

        {shared.data && shared.data.items.length > 0 && (
          <div className="compare-grid">
            {shared.data.items.map((item) => (
              <div key={item.canonical_product_id} className="compare-card">
                {item.image_url && (
                  <SafeImage src={item.image_url} alt={pickText(lang, item.name_en, item.name_ar) || t("cset.product")} className="compare-thumb" />
                )}
                {item.available ? (
                  <>
                    <Link href={`/compare/${item.canonical_product_id}`}>
                      <strong>{pickText(lang, item.name_en, item.name_ar)}</strong>
                    </Link>
                    {item.lowest_price && (
                      <div className="product-card-price">{item.lowest_price} ₪</div>
                    )}
                  </>
                ) : (
                  <span className="muted">{t("cset.unavailable_now")}</span>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
