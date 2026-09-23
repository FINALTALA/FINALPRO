"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense } from "react";
import ProductCard from "@/components/ProductCard";
import { EmptyState, ErrorBanner, SkeletonGrid } from "@/components/States";
import { useFetch } from "@/lib/useFetch";
import { CardsPageDto, SEGMENTS, StoreSummaryDto } from "@/lib/types";

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
        <h1 className="page-title">{q ? `نتائج البحث عن «${q}»` : "اكتشف المنتجات"}</h1>
        <p className="page-subtitle">
          {q
            ? "منتجات ومتاجر مطابقة لبحثك."
            : "منتجات من كل المتاجر، مع أقل سعر وعدد المتاجر التي تبيعها."}
        </p>

        <div className="category-strip" aria-label="الفئات">
          {SEGMENTS.map((s) => (
            <button
              key={s.key}
              className={`category-chip${segment === s.key ? " active" : ""}`}
              onClick={() => go({ segment: s.key, page: 1 })}
              aria-pressed={segment === s.key}
            >
              {s.label}
            </button>
          ))}
        </div>

        {q && stores.data && stores.data.items.length > 0 && (
          <>
            <div className="section-heading">
              <h2>المتاجر</h2>
            </div>
            <div className="follow-strip">
              {stores.data.items.map((s) => (
                <Link key={s.slug} href={`/store/${s.slug}`} className="follow-item">
                  <div className="follow-item-circle">
                    {s.logo_url ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img src={s.logo_url} alt={s.display_name} />
                    ) : (
                      <span>{s.display_name.slice(0, 1)}</span>
                    )}
                  </div>
                  <span>{s.display_name}</span>
                </Link>
              ))}
            </div>
          </>
        )}

        {q && (
          <div className="section-heading">
            <h2>المنتجات</h2>
          </div>
        )}

        {products.error && <ErrorBanner message={products.error} />}
        {products.loading && <SkeletonGrid />}

        {products.data && products.data.items.length === 0 && (
          <EmptyState
            title={q ? "لا توجد منتجات مطابقة" : "لا توجد منتجات في هذه الفئة حالياً"}
            message={q ? "جرّبي كلمات أخرى أو فئة مختلفة." : "جرّبي فئة أخرى أو عودي لاحقاً."}
            actionHref="/discovery"
            actionLabel="عرض كل المنتجات"
          />
        )}

        {products.data && products.data.items.length > 0 && (
          <>
            <div className="product-grid">
              {products.data.items.map((card) => (
                <ProductCard key={card.canonical_product_id} card={card} />
              ))}
            </div>

            {totalPages > 1 && (
              <div style={{ display: "flex", gap: 8, justifyContent: "center", alignItems: "center", marginTop: 24 }}>
                <button className="button-link" disabled={page <= 1} onClick={() => go({ page: page - 1 })}>
                  السابق
                </button>
                <span className="muted">
                  صفحة {products.data.page} من {totalPages}
                </span>
                <button className="button-link" disabled={page >= totalPages} onClick={() => go({ page: page + 1 })}>
                  التالي
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
