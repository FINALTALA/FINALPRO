"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect } from "react";
import ProductCard from "@/components/ProductCard";
import { EmptyState, ErrorBanner, SkeletonGrid } from "@/components/States";
import { clearSession } from "@/lib/session";
import { CardsPageDto, StoreSummaryDto } from "@/lib/types";
import { useFetch } from "@/lib/useFetch";
import { useHydrated, useSessionToken } from "@/lib/useSession";

// Sprint 13 (RB-STOREF-003): "أتابعه" - the stores the signed-in
// customer follows. A horizontal strip of followed-store logos, then
// the same global product cards as Home, limited to eligible products
// sold by those stores. Unpublished/inactive stores never appear (the
// follow is kept server-side and returns when the store does).
export default function FollowingPage() {
  const router = useRouter();
  const hydrated = useHydrated();
  const token = useSessionToken();
  const stores = useFetch<{ items: (StoreSummaryDto & { followed_at: string })[] }>(
    token ? "/customers/me/following" : null,
    true,
  );
  const feed = useFetch<CardsPageDto>(
    token ? "/customers/me/following/feed?page_size=24" : null,
    true,
  );

  useEffect(() => {
    if (stores.status === 401 || feed.status === 401) {
      clearSession();
      router.replace("/login?next=/following");
    }
  }, [stores.status, feed.status, router]);

  if (!hydrated) {
    return (
      <div className="page-shell">
        <div className="skeleton" style={{ height: 96, width: "100%", maxWidth: 1240 }} />
      </div>
    );
  }

  if (!token) {
    return (
      <div className="page-shell">
        <EmptyState
          title="سجّلي الدخول لمتابعة المتاجر"
          message="تابعي متاجرك المفضلة لتصلك منتجاتها هنا."
          actionHref="/login?next=/following"
          actionLabel="تسجيل الدخول"
        />
      </div>
    );
  }

  const noStores = stores.data && stores.data.items.length === 0;

  return (
    <div className="page-shell">
      <div className="wide-shell">
        <h1 className="page-title">أتابعه</h1>
        <p className="page-subtitle">المتاجر التي تتابعينها ومنتجاتها.</p>

        {stores.error && stores.status !== 401 && <ErrorBanner message={stores.error} />}
        {stores.loading && <div className="skeleton" style={{ height: 96 }} />}

        {stores.data && stores.data.items.length > 0 && (
          <div className="follow-strip" aria-label="المتاجر التي أتابعها">
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
        )}

        {noStores && (
          <EmptyState
            title="لا تتابعين أي متجر بعد"
            message="افتحي صفحة أي متجر واضغطي «تابعي المتجر»."
            actionHref="/discovery"
            actionLabel="اكتشفي المتاجر والمنتجات"
          />
        )}

        {!noStores && (
          <>
            <div className="section-heading">
              <h2>منتجات متاجرك</h2>
            </div>
            {feed.loading && <SkeletonGrid count={4} />}
            {feed.data && feed.data.items.length === 0 && (
              <EmptyState
                title="لا توجد منتجات متاحة من متاجرك حالياً"
                message="ستظهر هنا فور نشر عروض جديدة."
              />
            )}
            {feed.data && feed.data.items.length > 0 && (
              <div className="product-grid">
                {feed.data.items.map((card) => (
                  <ProductCard key={card.canonical_product_id} card={card} />
                ))}
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
