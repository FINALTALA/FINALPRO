"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense } from "react";
import ProductCard from "@/components/ProductCard";
import Reveal from "@/components/Reveal";
import SafeImage from "@/components/SafeImage";
import { EmptyState, ErrorBanner, SkeletonGrid } from "@/components/States";
import { useFetch } from "@/lib/useFetch";
import { CardsPageDto, SEGMENTS, StoreSummaryDto } from "@/lib/types";
import CollectionLinks from "@/components/CollectionLinks";
import { registerTranslations, translate } from "@/lib/i18n";
import { useLang } from "@/lib/useLang";
import { apiErrorMessage } from "@/lib/apiErrors";
import { fmt, segmentLabel } from "@/lib/shopText";

registerTranslations({
  ar: {
    "disc.results_for": "نتائج البحث عن «{q}»",
    "disc.title": "اكتشف المنتجات",
    "disc.sub_search": "منتجات ومتاجر مطابقة لبحثك.",
    "disc.sub": "منتجات من كل المتاجر، مع أقل سعر وعدد المتاجر التي تبيعها.",
    "disc.categories": "الفئات",
    "disc.stores": "المتاجر",
    "disc.products": "المنتجات",
    "disc.empty_search": "لا توجد منتجات مطابقة",
    "disc.empty": "لا توجد منتجات في هذه الفئة حالياً",
    "disc.empty_search_msg": "جرّبي كلمات أخرى أو فئة مختلفة.",
    "disc.empty_msg": "جرّبي فئة أخرى أو عودي لاحقاً.",
    "disc.show_all": "عرض كل المنتجات",
  },
  en: {
    "disc.results_for": "Search results for “{q}”",
    "disc.title": "Discover products",
    "disc.sub_search": "Products and stores that match your search.",
    "disc.sub": "Products from every store, with the lowest price and how many stores sell them.",
    "disc.categories": "Categories",
    "disc.stores": "Stores",
    "disc.products": "Products",
    "disc.empty_search": "No matching products",
    "disc.empty": "No products in this category yet",
    "disc.empty_search_msg": "Try other words or a different category.",
    "disc.empty_msg": "Try another category or come back later.",
    "disc.show_all": "Show all products",
  },
});

const PAGE_SIZE = 20;

function buildQuery(params: Record<string, string | number | null>): string {
  const usp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v !== null && v !== "" && v !== undefined) usp.set(k, String(v));
  }
  const s = usp.toString();
  return s ? `?${s}` : "";
}

// Sprint 8 (RB-STOREF-004, PDR-013/015): public discovery. Sprint 13:
// real category segments (?segment=) and search (?q=) backed by
// GET /discovery/all and GET /discovery/stores - cards keep the exact
// global-card behaviour (image/name -> cheapest offer in its store;
// store circles -> that store's offer; "قارني الأسعار" -> comparison).
function DiscoveryInner() {
  const router = useRouter();
  const search = useSearchParams();
  const lang = useLang();
  const t = (key: string) => translate(lang, key);
  const segment = search.get("segment") ?? "all";
  const q = search.get("q") ?? "";
  const page = Math.max(1, Number.parseInt(search.get("page") ?? "1", 10) || 1);

  const products = useFetch<CardsPageDto>(
    `/discovery/all${buildQuery({ page, page_size: PAGE_SIZE, segment: segment === "all" ? null : segment, q })}`,
  );
  const stores = useFetch<{ items: StoreSummaryDto[] }>(
    q ? `/discovery/stores${buildQuery({ q, segment: segment === "all" ? null : segment })}` : null,
  );

  const totalPages = products.data
    ? Math.max(1, Math.ceil(products.data.total / products.data.page_size))
    : 1;

  function go(next: { segment?: string; page?: number }) {
    router.push(
      `/discovery${buildQuery({
        segment: (next.segment ?? segment) === "all" ? null : (next.segment ?? segment),
        q,
        page: next.page && next.page > 1 ? next.page : null,
      })}`,
    );
  }

  return (
    <div className="page-shell">
      <div className="wide-shell">
        <h1 className="page-title">{q ? fmt(t("disc.results_for"), { q }) : t("disc.title")}</h1>
        <p className="page-subtitle">
          {q ? t("disc.sub_search") : t("disc.sub")}
        </p>

        <div className="category-strip" aria-label={t("disc.categories")}>
          {SEGMENTS.map((s) => (
            <button
              key={s.key}
              className={`category-chip${segment === s.key ? " active" : ""}`}
              onClick={() => go({ segment: s.key, page: 1 })}
              aria-pressed={segment === s.key}
            >
              {segmentLabel(lang, s.key, s.label)}
            </button>
          ))}
        </div>
        {/* PD-5b.4: links to the live collections (no cards here; none -> nothing). */}
        <CollectionLinks />

        {q && stores.data && stores.data.items.length > 0 && (
          <Reveal>
            <div className="section-heading">
              <h2>{t("disc.stores")}</h2>
            </div>
            <div className="follow-strip">
              {stores.data.items.map((s) => (
                <Link key={s.slug} href={`/store/${s.slug}`} className="follow-item">
                  <div className="follow-item-circle">
                    {s.logo_url ? (
                      <SafeImage src={s.logo_url} alt={s.display_name} />
                    ) : (
                      <span>{s.display_name.slice(0, 1)}</span>
                    )}
                  </div>
                  <span>{s.display_name}</span>
                </Link>
              ))}
            </div>
          </Reveal>
        )}

        {q && (
          <div className="section-heading">
            <h2>{t("disc.products")}</h2>
          </div>
        )}

        {products.error && <ErrorBanner message={apiErrorMessage(products.apiError, lang)} />}
        {products.loading && <SkeletonGrid />}

        {products.data && products.data.items.length === 0 && (
          <EmptyState
            title={q ? t("disc.empty_search") : t("disc.empty")}
            message={q ? t("disc.empty_search_msg") : t("disc.empty_msg")}
            actionHref="/discovery"
            actionLabel={t("disc.show_all")}
          />
        )}

        {products.data && products.data.items.length > 0 && (
          <>
            <Reveal className="product-grid">
              {products.data.items.map((card) => (
                <ProductCard key={card.canonical_product_id} card={card} />
              ))}
            </Reveal>

            {totalPages > 1 && (
              <div style={{ display: "flex", gap: 8, justifyContent: "center", alignItems: "center", marginTop: 24 }}>
                <button className="button-link" disabled={page <= 1} onClick={() => go({ page: page - 1 })}>
                  {t("shop.prev")}
                </button>
                <span className="muted">
                  {fmt(t("shop.page_of"), { page: products.data.page, total: totalPages })}
                </span>
                <button className="button-link" disabled={page >= totalPages} onClick={() => go({ page: page + 1 })}>
                  {t("shop.next")}
                </button>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}

export default function DiscoveryPage() {
  return (
    <Suspense fallback={<div className="page-shell"><SkeletonGrid count={5} /></div>}>
      <DiscoveryInner />
    </Suspense>
  );
}
