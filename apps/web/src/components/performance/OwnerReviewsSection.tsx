"use client";

import { useEffect, useState } from "react";
import { ReviewStars } from "@/components/ProductReviews";
import { ErrorBanner } from "@/components/States";
import { apiFetch } from "@/lib/api";
import { isUnauthorized } from "@/lib/apiErrors";
import { fillPf } from "@/lib/performanceText";
import { fitLabel, purchasedLineIn, reviewErrorMessage, tagLabel, type ReviewDto } from "@/lib/reviews";
import { useLang, useT } from "@/lib/useLang";
import { useSessionExpiredRedirect } from "@/lib/useSessionExpiredRedirect";

interface OwnerReviewDto extends ReviewDto {
  product_name: string | null;
}
interface OwnerReviewsPage {
  aggregate: { average: number | null; count: number };
  reviews: OwnerReviewDto[];
  next_cursor: string | null;
}
type Tab = "ALL" | "PRODUCT" | "STORE";
const TABS: Tab[] = ["ALL", "PRODUCT", "STORE"];

/**
 * «تقييمات العملاء» (PD-3, decision 11; moved from its own page into «أداء
 * المتجر» › «العملاء»): every review of what the store sold and of the store
 * itself - read only by design (no edit, delete, hide or reply). Same API
 * (GET /vendors/:id/product-reviews, OWNER only), same filters and «المزيد».
 */
export default function OwnerReviewsSection({ vendorId }: { vendorId: string }) {
  const t = useT();
  const lang = useLang();
  const onExpired = useSessionExpiredRedirect();
  const [tab, setTab] = useState<Tab>("ALL");
  // Keyed by tab so a switch shows the skeleton until its first page arrives.
  const [loaded, setLoaded] = useState<{ tab: Tab; data: OwnerReviewsPage | null; error: string | null } | null>(null);
  const [items, setItems] = useState<OwnerReviewDto[]>([]);
  const [moreError, setMoreError] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const current = loaded?.tab === tab ? loaded : null;
  const data = current?.data ?? null;
  const error = current?.error ?? moreError;
  const failed = (err: unknown) => (lang === "ar" ? reviewErrorMessage(err) : t("pf.reviews.failed"));

  const path = (cursor: string | null) =>
    `/vendors/${vendorId}/product-reviews?limit=20${tab === "ALL" ? "" : `&target=${tab}`}${cursor ? `&cursor=${cursor}` : ""}`;

  useEffect(() => {
    let cancelled = false;
    apiFetch<OwnerReviewsPage>(path(null)).then(
      (res) => {
        if (cancelled) return;
        setItems(res.reviews);
        setLoaded({ tab, data: res, error: null });
      },
      (err: unknown) => {
        if (cancelled) return;
        if (isUnauthorized(err)) return onExpired();
        setLoaded({ tab, data: null, error: failed(err) });
      },
    );
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [vendorId, tab, onExpired]);

  async function more() {
    if (!data?.next_cursor) return;
    setLoadingMore(true);
    try {
      const res = await apiFetch<OwnerReviewsPage>(path(data.next_cursor));
      setLoaded({ tab, data: { ...res, aggregate: data.aggregate }, error: null });
      setItems((all) => [...all, ...res.reviews]);
    } catch (err) {
      if (isUnauthorized(err)) return onExpired();
      setMoreError(failed(err));
    } finally {
      setLoadingMore(false);
    }
  }

  const tabLabel = (x: Tab) => t(`pf.reviews.tab.${x}`);
  return (
    <section className="pf-part owner-reviews" aria-labelledby="pf-reviews-title" data-testid="pf-reviews">
      <h3 className="pf-part-title" id="pf-reviews-title">{t("pf.reviews.title")}</h3>
      <p className="muted owner-reviews-note">{t("pf.reviews.lead")}</p>

      <div className="rv-toolbar" role="tablist" aria-label={t("pf.reviews.kinds")}>
        {TABS.map((x) => (
          <button key={x} type="button" role="tab" aria-selected={tab === x} className={`rv-pill${tab === x ? " is-on" : ""}`} onClick={() => setTab(x)} data-testid={`pf-reviews-tab-${x}`}>
            {tabLabel(x)}
          </button>
        ))}
      </div>

      {error && <ErrorBanner message={error} />}
      {!data && !error && <div className="skeleton" style={{ height: 160, width: "100%" }} />}
      {data && (
        <>
          <div className="owner-reviews-score">
            {data.aggregate.average !== null ? (
              <>
                <strong>{data.aggregate.average.toFixed(1)}</strong>
                <ReviewStars value={data.aggregate.average} size="lg" />
                <span>{fillPf(t("pf.reviews.of_n"), { n: data.aggregate.count })}</span>
              </>
            ) : (
              <span>{data.aggregate.count === 0 ? t("pf.reviews.none") : fillPf(t("pf.reviews.avg_after"), { n: data.aggregate.count })}</span>
            )}
          </div>
          {items.length === 0 ? (
            <div className="rv-empty">
              <strong>{tab === "ALL" ? t("pf.reviews.empty_all") : fillPf(t("pf.reviews.empty_tab"), { tab: tabLabel(tab) })}</strong>
            </div>
          ) : (
            <ul className="rv-list">
              {items.map((r) => {
                const bought = purchasedLineIn(r.purchased, lang);
                return (
                  <li key={r.id} className="rv-card">
                    <div className="rv-card-head">
                      <span className="rv-avatar" aria-hidden="true">{[...r.author][0]}</span>
                      <div className="rv-card-who">
                        <strong dir="auto">{r.author}</strong>
                        <span className="rv-own" dir="auto">{r.target_type === "STORE" ? t("pf.reviews.about_store") : r.product_name ?? t("pf.reviews.product")}</span>
                      </div>
                      <time dateTime={r.created_at}>
                        {new Date(r.created_at).toLocaleDateString(lang === "en" ? "en-GB" : "ar-EG", { year: "numeric", month: "short", day: "numeric" })}
                        {r.edited && <span className="rv-edited"> · {t("pf.reviews.edited")}</span>}
                      </time>
                    </div>
                    <ReviewStars value={r.rating} size="sm" />
                    {(bought || r.fit || r.returned) && (
                      <dl className="rv-facts">
                        {bought && <div><dd>{bought}</dd></div>}
                        {r.fit && r.fit !== "NOT_APPLICABLE" && <div><dt>{t("pf.reviews.fit")}</dt><dd>{fitLabel(lang, r.fit)}</dd></div>}
                        {r.returned && <div className="rv-returned"><dd>{t("pf.reviews.returned")}</dd></div>}
                      </dl>
                    )}
                    {r.tags.length > 0 && <div className="rv-card-tags">{r.tags.map((x) => <span key={x} className="rv-tag">{tagLabel(lang, x)}</span>)}</div>}
                    <p className="rv-body" dir="auto">{r.body}</p>
                    {r.media.length > 0 && (
                      <div className="rv-card-media">
                        {r.media.map((m) => (
                          <a key={m.id} href={m.url} target="_blank" rel="noreferrer">
                            {/* eslint-disable-next-line @next/next/no-img-element */}
                            <img src={m.url} alt={m.alt_text ?? t("pf.reviews.photo_alt")} loading="lazy" />
                          </a>
                        ))}
                      </div>
                    )}
                    {r.helpful_count > 0 && <span className="rv-helpful-count">{fillPf(t("pf.reviews.helpful_n"), { n: r.helpful_count })}</span>}
                  </li>
                );
              })}
            </ul>
          )}
          {data.next_cursor && (
            <button type="button" className="rv-more" onClick={more} disabled={loadingMore} data-testid="pf-reviews-more">
              {loadingMore ? t("pf.reviews.loading") : t("pf.reviews.more")}
            </button>
          )}
        </>
      )}
    </section>
  );
}
