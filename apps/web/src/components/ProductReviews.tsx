"use client";

import { usePathname, useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { StarIcon } from "./Icons";
import ReviewComposer from "./ReviewComposer";
import { apiFetch, newIdempotencyKey } from "@/lib/api";
import {
  activeReviewFilterCount,
  fitLabel,
  NO_REVIEW_FILTERS,
  purchasedLineIn,
  ReviewDto,
  ReviewFilters,
  ReviewMediaDto,
  reviewErrorMessageIn,
  reviewsQuery,
  ReviewsPageDto,
  ReviewSort,
  share,
  sortLabel,
  tagLabel,
  type ReviewSort as Sort,
} from "@/lib/reviews";
import { useSessionToken } from "@/lib/useSession";
import { registerTranslations, translate, type Lang } from "@/lib/i18n";
import { useLang } from "@/lib/useLang";
import { apiErrorMessage } from "@/lib/apiErrors";
import { useTaxonomy } from "@/lib/taxonomy";
import { colorName, sizeName } from "@/lib/localized";
import { fmt } from "@/lib/shopText";
import { loginHref } from "@/lib/loginRedirect";

// TB-25: the reviews section's own words (Arabic unchanged).
registerTranslations({
  ar: {
    "rv.of5": "{v} من 5",
    "rv.deleted": "حُذف تقييمك.",
    "rv.title": "تقييمات العملاء",
    "rv.subtitle": "تقييمات موثّقة من مشترين استلموا هذا المنتج فعلاً من متاجر المنصة.",
    "rv.loading": "جارٍ تحميل التقييمات",
    "rv.none": "لا توجد تقييمات لهذا المنتج بعد",
    "rv.none_hint": "تظهر هنا تقييمات المشترين بعد استلامهم المنتج. إن اشتريتِه، قيّميه من «طلباتي».",
    "rv.from_n": "من {n} تقييم",
    "rv.no_average": "لا يوجد متوسط بعد",
    "rv.average_after": "يظهر المتوسط وتوزيع النجوم بعد 3 تقييمات{now}.",
    "rv.now_have": " - لدينا الآن {n}",
    "rv.distribution": "توزيع النجوم",
    "rv.n_stars_count": "{n} نجوم: {count}",
    "rv.fit": "ملاءمة المقاس",
    "rv.fit_aria": "صغير {s}٪، مناسب {t}٪، كبير {l}٪",
    "rv.fit_answered": "من {n} مشترٍ أجابوا عن المقاس",
    "rv.fit_none": "لا توجد بيانات كافية عن المقاس بعد.",
    "rv.impressions": "انطباعات المشترين",
    "rv.filter": "فلترة التقييمات",
    "rv.all": "الكل",
    "rv.with_photos": "مع صور",
    "rv.this_store": "من هذا المتجر فقط",
    "rv.clear_stars": "إزالة فلتر {n} نجوم",
    "rv.n_stars": "{n} نجوم",
    "rv.clear_fit": "إزالة فلتر الملاءمة {fit}",
    "rv.fit_chip": "الملاءمة: {fit}",
    "rv.color": "اللون",
    "rv.all_colors": "كل الألوان",
    "rv.size": "المقاس",
    "rv.all_sizes": "كل المقاسات",
    "rv.sort": "ترتيب:",
    "rv.no_match": "لا توجد تقييمات تطابق هذا الفلتر",
    "rv.clear_filters": "إزالة الفلاتر",
    "rv.loading_more": "جارٍ التحميل…",
    "rv.more": "عرض المزيد من التقييمات",
    "rv.verified": "مشترٍ موثّق",
    "rv.yours": "تقييمك",
    "rv.edited": " · معدّل",
    "rv.bought": "ما اشتراه",
    "rv.fit_label": "الملاءمة:",
    "rv.bought_from": "اشترى من:",
    "rv.returned": "تم إرجاعه",
    "rv.view_image": "عرض الصورة {i} من {n}",
    "rv.image_alt": "صورة من تقييم عميل",
    "rv.helpful": "مفيد",
    "rv.found_helpful": "وجده {n} مفيداً",
    "rv.edit_yours": "تعديل تقييمك",
    "rv.report": "إبلاغ",
    "rv.write_reason": "اكتبي سبب البلاغ.",
    "rv.report_received": "وصل بلاغك، وستراجعه الإدارة.",
    "rv.reason": "سبب البلاغ",
    "rv.reason_placeholder": "مثال: محتوى مسيء أو لا علاقة له بالمنتج",
    "rv.about": "يتعلق البلاغ بـ",
    "rv.whole_review": "التقييم كله",
    "rv.image_n": "الصورة {n}",
    "rv.sending": "جارٍ الإرسال…",
    "rv.send_report": "إرسال البلاغ",
    "rv.images": "صور التقييم",
    "rv.close": "إغلاق",
    "rv.prev_image": "الصورة السابقة",
    "rv.next_image": "الصورة التالية",
  },
  en: {
    "rv.of5": "{v} out of 5",
    "rv.deleted": "Your review was deleted.",
    "rv.title": "Customer reviews",
    "rv.subtitle": "Verified reviews from buyers who actually received this product from the platform's stores.",
    "rv.loading": "Loading reviews",
    "rv.none": "No reviews for this product yet",
    "rv.none_hint": "Buyers' reviews appear here once they receive the product. If you bought it, review it from «My orders».",
    "rv.from_n": "from {n} reviews",
    "rv.no_average": "No average yet",
    "rv.average_after": "The average and star breakdown appear after 3 reviews{now}.",
    "rv.now_have": " - we have {n} so far",
    "rv.distribution": "Star breakdown",
    "rv.n_stars_count": "{n} stars: {count}",
    "rv.fit": "Size fit",
    "rv.fit_aria": "Small {s}%, true to size {t}%, large {l}%",
    "rv.fit_answered": "from {n} buyers who answered about the size",
    "rv.fit_none": "Not enough size data yet.",
    "rv.impressions": "Buyers' impressions",
    "rv.filter": "Filter reviews",
    "rv.all": "All",
    "rv.with_photos": "With photos",
    "rv.this_store": "From this store only",
    "rv.clear_stars": "Remove the {n}-star filter",
    "rv.n_stars": "{n} stars",
    "rv.clear_fit": "Remove the fit filter {fit}",
    "rv.fit_chip": "Fit: {fit}",
    "rv.color": "Colour",
    "rv.all_colors": "All colours",
    "rv.size": "Size",
    "rv.all_sizes": "All sizes",
    "rv.sort": "Sort:",
    "rv.no_match": "No reviews match this filter",
    "rv.clear_filters": "Clear filters",
    "rv.loading_more": "Loading…",
    "rv.more": "Show more reviews",
    "rv.verified": "Verified buyer",
    "rv.yours": "Your review",
    "rv.edited": " · edited",
    "rv.bought": "What they bought",
    "rv.fit_label": "Fit:",
    "rv.bought_from": "Bought from:",
    "rv.returned": "Returned",
    "rv.view_image": "View image {i} of {n}",
    "rv.image_alt": "Image from a customer review",
    "rv.helpful": "Helpful",
    "rv.found_helpful": "{n} found this helpful",
    "rv.edit_yours": "Edit your review",
    "rv.report": "Report",
    "rv.write_reason": "Write the reason for the report.",
    "rv.report_received": "We've received your report; the platform will review it.",
    "rv.reason": "Reason for the report",
    "rv.reason_placeholder": "For example: offensive content or unrelated to the product",
    "rv.about": "The report is about",
    "rv.whole_review": "The whole review",
    "rv.image_n": "Image {n}",
    "rv.sending": "Sending…",
    "rv.send_report": "Send report",
    "rv.images": "Review images",
    "rv.close": "Close",
    "rv.prev_image": "Previous image",
    "rv.next_image": "Next image",
  },
});

/** A failure kept until render: an API error (worded by code) or a key. */
type RvMsg = { api: unknown } | { key: string };

const PAGE_SIZE = 6;

export function ReviewStars({ value, size = "md" }: { value: number; size?: "sm" | "md" | "lg" }) {
  const lang = useLang();
  return (
    <span className={`rv-stars rv-stars-${size}`} role="img" aria-label={fmt(translate(lang, "rv.of5"), { v: value.toFixed(1) })}>
      {[1, 2, 3, 4, 5].map((i) => (
        <span key={i} className={value >= i - 0.25 ? "on" : value >= i - 0.75 ? "half" : ""} aria-hidden="true">
          <StarIcon />
        </span>
      ))}
    </span>
  );
}

/**
 * PD-3: the product page's customer reviews - only what the API returns
 * (purchase-verified reviews of this canonical product from every store),
 * a summary whose parts appear only once the API has enough to show,
 * filters/sort, cursor paging, "helpful", reporting, an image viewer and
 * the author's own edit panel.
 */
export default function ProductReviews({
  canonicalId,
  storeSlug,
  onAggregate,
}: {
  canonicalId: string;
  /** The store whose page this is - for "من هذا المتجر فقط". */
  storeSlug: string;
  onAggregate?: (aggregate: ReviewsPageDto["aggregate"]) => void;
}) {
  const lang = useLang();
  const t = (key: string) => translate(lang, key);
  const taxonomy = useTaxonomy().data;
  const token = useSessionToken();
  const router = useRouter();
  const pathname = usePathname();
  const [filters, setFilters] = useState<ReviewFilters>(NO_REVIEW_FILTERS);
  const [page, setPage] = useState<ReviewsPageDto | null>(null);
  const [items, setItems] = useState<ReviewDto[]>([]);
  // The filters (and session) the shown first page was loaded for; the
  // list is "loading" whenever that differs from the current ones.
  const [loadedKey, setLoadedKey] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<RvMsg | null>(null);
  const [notice, setNotice] = useState<RvMsg | null>(null);
  const msgText = (m: RvMsg) => ("api" in m ? reviewErrorMessageIn(m.api, lang, (e) => apiErrorMessage(e, lang)) : t(m.key));
  const [viewer, setViewer] = useState<{ media: ReviewMediaDto[]; index: number } | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [reporting, setReporting] = useState<string | null>(null);
  const [busyVote, setBusyVote] = useState<string | null>(null);

  const load = useCallback(
    async (f: ReviewFilters, cursor: string | null) => {
      const res = await apiFetch<ReviewsPageDto>(
        `/canonical-products/${canonicalId}/reviews?${reviewsQuery(f, cursor, PAGE_SIZE)}`,
      );
      return res;
    },
    [canonicalId],
  );

  // First page on every filter change (and when the session changes,
  // since a signed-in viewer gets their own vote/edit flags).
  const key = `${token ?? ""}|${reviewsQuery(filters, null, PAGE_SIZE)}`;
  const loading = loadedKey !== key;
  useEffect(() => {
    let cancelled = false;
    load(filters, null)
      .then((res) => {
        if (cancelled) return;
        setPage(res);
        setItems(res.reviews);
        setError(null);
        onAggregate?.(res.aggregate);
      })
      .catch((err) => !cancelled && setError({ api: err }))
      .finally(() => !cancelled && setLoadedKey(key));
    return () => {
      cancelled = true;
    };
  }, [filters, load, key, onAggregate]);

  async function more() {
    if (!page?.next_cursor) return;
    setLoadingMore(true);
    try {
      const res = await load(filters, page.next_cursor);
      setPage({ ...res, summary: page.summary, aggregate: page.aggregate });
      setItems((all) => [...all, ...res.reviews.filter((r) => !all.some((a) => a.id === r.id))]);
    } catch (err) {
      setError({ api: err });
    } finally {
      setLoadingMore(false);
    }
  }

  const set = (patch: Partial<ReviewFilters>) => setFilters((f) => ({ ...f, ...patch }));
  const needSignIn = () => router.push(loginHref(`${pathname}${typeof window === "undefined" ? "" : window.location.search}#reviews`));

  async function toggleHelpful(r: ReviewDto) {
    if (!token) return needSignIn();
    setBusyVote(r.id);
    try {
      const res = await apiFetch<{ voted: boolean; helpful_count: number }>(`/reviews/${r.id}/helpful`, {
        method: r.viewer?.voted_helpful ? "DELETE" : "POST",
      });
      setItems((all) =>
        all.map((x) =>
          x.id === r.id
            ? { ...x, helpful_count: res.helpful_count, viewer: x.viewer ? { ...x.viewer, voted_helpful: res.voted } : x.viewer }
            : x,
        ),
      );
    } catch (err) {
      setNotice({ api: err });
    } finally {
      setBusyVote(null);
    }
  }

  function saved(id: string, review: ReviewDto | null) {
    if (review === null) {
      setItems((all) => all.filter((x) => x.id !== id));
      setNotice({ key: "rv.deleted" });
      return;
    }
    setItems((all) => all.map((x) => (x.id === id ? { ...x, ...review, viewer: x.viewer } : x)));
  }

  const summary = page?.summary ?? null;
  const aggregate = page?.aggregate ?? null;
  const filterCount = activeReviewFilterCount(filters);
  const opts = summary?.filter_options;
  const sellsHere = opts?.stores.some((s) => s.slug === storeSlug) ?? false;
  const nothingAtAll = !loading && page !== null && page.total === 0 && filterCount === 0;

  return (
    <section className="rv-section" id="reviews" aria-labelledby="rv-title">
      <div className="rv-section-head">
        <h2 id="rv-title">{t("rv.title")} {page && page.total > 0 && filterCount === 0 && <span>({page.total})</span>}</h2>
        <p>{t("rv.subtitle")}</p>
      </div>

      {error && <p className="rv-error" role="alert">{msgText(error)}</p>}
      {notice && <p className="rv-notice" role="status" onAnimationEnd={() => setNotice(null)}>{msgText(notice)}</p>}

      {loading && !page ? (
        <div className="rv-skeleton" aria-busy="true" aria-label={t("rv.loading")}><span /><span /><span /></div>
      ) : nothingAtAll ? (
        <div className="rv-empty">
          <strong>{t("rv.none")}</strong>
          <p>{t("rv.none_hint")}</p>
        </div>
      ) : page && summary && aggregate ? (
        <>
          <div className={`rv-summary${summary.distribution ? "" : " is-partial"}`}>
            <div className="rv-summary-score">
              {aggregate.average !== null ? (
                <>
                  <strong>{aggregate.average.toFixed(1)}</strong>
                  <ReviewStars value={aggregate.average} size="lg" />
                  <span>{fmt(t("rv.from_n"), { n: aggregate.count })}</span>
                </>
              ) : (
                <>
                  <ReviewStars value={0} size="lg" />
                  <span className="rv-summary-pending">{t("rv.no_average")}</span>
                  <span>{fmt(t("rv.average_after"), { now: aggregate.count > 0 ? fmt(t("rv.now_have"), { n: aggregate.count }) : "" })}</span>
                </>
              )}
            </div>

            {summary.distribution && (
              <ul className="rv-distribution" aria-label={t("rv.distribution")}>
                {([5, 4, 3, 2, 1] as const).map((n) => {
                  const count = summary.distribution![String(n) as "1"];
                  return (
                    <li key={n}>
                      <button
                        type="button"
                        className={filters.rating === n ? "is-on" : ""}
                        aria-pressed={filters.rating === n}
                        onClick={() => set({ rating: filters.rating === n ? null : n })}
                        disabled={count === 0 && filters.rating !== n}
                        aria-label={fmt(t("rv.n_stars_count"), { n, count })}
                      >
                        <span className="rv-distribution-n">{n}<StarIcon /></span>
                        <span className="rv-bar"><span style={{ width: `${share(count, aggregate.count)}%` }} /></span>
                        <span className="rv-distribution-count">{count}</span>
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}

            <div className="rv-summary-side">
              <div className="rv-fit">
                <span className="rv-label">{t("rv.fit")}</span>
                {summary.fit ? (
                  <>
                    <div className="rv-fit-bar" role="img" aria-label={fmt(t("rv.fit_aria"), { s: share(summary.fit.SMALL, summary.fit.answered), t: share(summary.fit.TRUE_TO_SIZE, summary.fit.answered), l: share(summary.fit.LARGE, summary.fit.answered) })}>
                      <span className="is-small" style={{ flexGrow: summary.fit.SMALL }} />
                      <span className="is-true" style={{ flexGrow: summary.fit.TRUE_TO_SIZE }} />
                      <span className="is-large" style={{ flexGrow: summary.fit.LARGE }} />
                    </div>
                    <div className="rv-fit-legend">
                      {(["SMALL", "TRUE_TO_SIZE", "LARGE"] as const).map((f) => (
                        <button key={f} type="button" className={filters.fit === f ? "is-on" : ""} aria-pressed={filters.fit === f} onClick={() => set({ fit: filters.fit === f ? null : f })}>
                          {fitLabel(lang, f)} <b>{share(summary.fit![f], summary.fit!.answered)}{lang === "en" ? "%" : "٪"}</b>
                        </button>
                      ))}
                    </div>
                    <small>{fmt(t("rv.fit_answered"), { n: summary.fit.answered })}</small>
                  </>
                ) : (
                  <small className="rv-muted">{t("rv.fit_none")}</small>
                )}
              </div>
              {summary.tags.length > 0 && (
                <div className="rv-summary-tags" aria-label={t("rv.impressions")}>
                  {summary.tags.map((tg) => (
                    <span key={tg.tag} className="rv-tag">{tagLabel(lang, tg.tag)} <b>{tg.count}</b></span>
                  ))}
                </div>
              )}
            </div>
          </div>

          <div className="rv-toolbar" role="toolbar" aria-label={t("rv.filter")}>
            <button type="button" className={`rv-pill${filterCount === 0 ? " is-on" : ""}`} aria-pressed={filterCount === 0} onClick={() => setFilters({ ...NO_REVIEW_FILTERS, sort: filters.sort })}>{t("rv.all")}</button>
            <button type="button" className={`rv-pill${filters.hasMedia ? " is-on" : ""}`} aria-pressed={filters.hasMedia} onClick={() => set({ hasMedia: !filters.hasMedia })} disabled={summary.with_media === 0 && !filters.hasMedia}>
              {t("rv.with_photos")} {summary.with_media > 0 && <b>{summary.with_media}</b>}
            </button>
            {sellsHere && (
              <button type="button" className={`rv-pill${filters.store === storeSlug ? " is-on" : ""}`} aria-pressed={filters.store === storeSlug} onClick={() => set({ store: filters.store === storeSlug ? null : storeSlug })}>
                {t("rv.this_store")}
              </button>
            )}
            {/* Stars and fit are chosen from the summary above (its bars
                and fit labels); the active one shows here to clear it. */}
            {filters.rating && (
              <button type="button" className="rv-pill is-on rv-chip-clear" onClick={() => set({ rating: null })} aria-label={fmt(t("rv.clear_stars"), { n: filters.rating })}>
                {fmt(t("rv.n_stars"), { n: filters.rating })} <span aria-hidden="true">×</span>
              </button>
            )}
            {filters.fit && (
              <button type="button" className="rv-pill is-on rv-chip-clear" onClick={() => set({ fit: null })} aria-label={fmt(t("rv.clear_fit"), { fit: fitLabel(lang, filters.fit) })}>
                {fmt(t("rv.fit_chip"), { fit: fitLabel(lang, filters.fit) })} <span aria-hidden="true">×</span>
              </button>
            )}
            {opts && opts.colors.length > 0 && (
              <label className="rv-select">
                <span className="sr-only">{t("rv.color")}</span>
                <select value={filters.color ?? ""} onChange={(e) => set({ color: e.target.value || null })}>
                  <option value="">{t("rv.all_colors")}</option>
                  {opts.colors.map((c) => <option key={c.code} value={c.code}>{colorName(taxonomy, c.code, lang, c.label)} ({c.count})</option>)}
                </select>
              </label>
            )}
            {opts && opts.sizes.length > 0 && (
              <label className="rv-select">
                <span className="sr-only">{t("rv.size")}</span>
                <select value={filters.size ?? ""} onChange={(e) => set({ size: e.target.value || null })}>
                  <option value="">{t("rv.all_sizes")}</option>
                  {opts.sizes.map((s) => <option key={s.code} value={s.code}>{sizeName(s.code, s.label, lang)} ({s.count})</option>)}
                </select>
              </label>
            )}
            <label className="rv-select rv-sort">
              <span>{t("rv.sort")}</span>
              <select value={filters.sort} onChange={(e) => set({ sort: e.target.value as ReviewSort })}>
                {(["newest", "helpful", "rating_desc", "rating_asc"] as Sort[]).map((s) => <option key={s} value={s}>{sortLabel(lang, s)}</option>)}
              </select>
            </label>
          </div>

          {items.length === 0 && !loading ? (
            <div className="rv-empty rv-empty-filter">
              <strong>{t("rv.no_match")}</strong>
              <button type="button" className="rv-pill" onClick={() => setFilters({ ...NO_REVIEW_FILTERS, sort: filters.sort })}>{t("rv.clear_filters")}</button>
            </div>
          ) : (
            <ul className={`rv-list${loading ? " is-loading" : ""}`} aria-busy={loading}>
              {items.map((r) => (
                <ReviewCard
                  key={r.id}
                  review={r}
                  busyVote={busyVote === r.id}
                  reporting={reporting === r.id}
                  onHelpful={() => toggleHelpful(r)}
                  onOpenMedia={(index) => setViewer({ media: r.media, index })}
                  onEdit={() => setEditing(r.id)}
                  onReport={() => (token ? setReporting(reporting === r.id ? null : r.id) : needSignIn())}
                  onReported={(key) => {
                    setReporting(null);
                    setNotice({ key });
                  }}
                />
              ))}
            </ul>
          )}
          {page.next_cursor && (
            <button type="button" className="rv-more" onClick={more} disabled={loadingMore}>
              {loadingMore ? t("rv.loading_more") : t("rv.more")}
            </button>
          )}
        </>
      ) : null}

      {viewer && <MediaViewer media={viewer.media} index={viewer.index} onClose={() => setViewer(null)} />}
      {editing && (
        <ReviewComposer
          target={{ mode: "edit", reviewId: editing }}
          onClose={() => setEditing(null)}
          onSaved={(review) => saved(editing, review)}
        />
      )}
    </section>
  );
}

function ReviewCard({
  review: r,
  busyVote,
  reporting,
  onHelpful,
  onOpenMedia,
  onEdit,
  onReport,
  onReported,
}: {
  review: ReviewDto;
  busyVote: boolean;
  reporting: boolean;
  onHelpful: () => void;
  onOpenMedia: (index: number) => void;
  onEdit: () => void;
  onReport: () => void;
  onReported: (key: string) => void;
}) {
  const lang = useLang();
  const t = (key: string) => translate(lang, key);
  const taxonomy = useTaxonomy().data;
  const bought = purchasedLineIn(r.purchased, lang, (code) => colorName(taxonomy, code, lang), (code, label) => sizeName(code, label, lang));
  const own = r.viewer?.is_author ?? false;
  const canVote = r.viewer ? r.viewer.can_vote : true; // a guest is asked to sign in
  return (
    <li className={`rv-card${own ? " is-own" : ""}`}>
      <div className="rv-card-head">
        <span className="rv-avatar" aria-hidden="true">{[...r.author][0]}</span>
        <div className="rv-card-who">
          <strong>{r.author}</strong>
          <span className="rv-verified">{t("rv.verified")}</span>
          {own && <span className="rv-own">{t("rv.yours")}</span>}
        </div>
        <time dateTime={r.created_at}>
          {new Date(r.created_at).toLocaleDateString(lang === "en" ? "en-GB" : "ar-EG", { year: "numeric", month: "short", day: "numeric" })}
          {r.edited && <span className="rv-edited">{t("rv.edited")}</span>}
        </time>
      </div>
      <ReviewStars value={r.rating} size="sm" />
      {(bought || r.store || r.fit || r.returned) && (
        <dl className="rv-facts">
          {bought && <div><dt className="sr-only">{t("rv.bought")}</dt><dd>{bought}</dd></div>}
          {r.fit && r.fit !== "NOT_APPLICABLE" && <div><dt>{t("rv.fit_label")}</dt><dd>{fitLabel(lang, r.fit)}</dd></div>}
          {r.store && <div><dt>{t("rv.bought_from")}</dt><dd>{r.store.name}</dd></div>}
          {r.returned && <div className="rv-returned"><dd>{t("rv.returned")}</dd></div>}
        </dl>
      )}
      {r.tags.length > 0 && (
        <div className="rv-card-tags">{r.tags.map((tg) => <span key={tg} className="rv-tag">{tagLabel(lang, tg)}</span>)}</div>
      )}
      <p className="rv-body">{r.body}</p>
      {r.media.length > 0 && (
        <div className="rv-card-media">
          {r.media.map((m, i) => (
            <button key={m.id} type="button" onClick={() => onOpenMedia(i)} aria-label={fmt(t("rv.view_image"), { i: i + 1, n: r.media.length })}>
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={m.url} alt={m.alt_text ?? t("rv.image_alt")} loading="lazy" />
            </button>
          ))}
        </div>
      )}
      <div className="rv-card-foot">
        {!own && canVote && (
          <button type="button" className={`rv-helpful${r.viewer?.voted_helpful ? " is-on" : ""}`} aria-pressed={r.viewer?.voted_helpful ?? false} onClick={onHelpful} disabled={busyVote}>
            <HelpfulIcon /> {t("rv.helpful")}{r.helpful_count > 0 && <b>{r.helpful_count}</b>}
          </button>
        )}
        {(own || !canVote) && r.helpful_count > 0 && <span className="rv-helpful-count">{fmt(t("rv.found_helpful"), { n: r.helpful_count })}</span>}
        {own ? (
          r.viewer?.can_edit !== undefined && <button type="button" className="rv-link" onClick={onEdit}>{t("rv.edit_yours")}</button>
        ) : (
          (r.viewer?.can_report ?? true) && <button type="button" className="rv-link rv-report-link" onClick={onReport} aria-expanded={reporting}>{t("rv.report")}</button>
        )}
      </div>
      {reporting && <ReportForm reviewId={r.id} media={r.media} onDone={onReported} />}
    </li>
  );
}

function ReportForm({ reviewId, media, onDone }: { reviewId: string; media: ReviewMediaDto[]; onDone: (m: string) => void }) {
  const [reason, setReason] = useState("");
  const [mediaId, setMediaId] = useState("");
  const [busy, setBusy] = useState(false);
  const lang = useLang();
  const t = (key: string) => translate(lang, key);
  const [error, setError] = useState<RvMsg | null>(null);
  async function send() {
    if (!reason.trim()) return setError({ key: "rv.write_reason" });
    setBusy(true);
    setError(null);
    try {
      await apiFetch(`/reviews/${reviewId}/report`, {
        method: "POST",
        idempotencyKey: newIdempotencyKey("review-report"),
        body: { reason: reason.trim(), ...(mediaId ? { media_id: mediaId } : {}) },
      });
      onDone("rv.report_received");
    } catch (err) {
      setError({ api: err });
      setBusy(false);
    }
  }
  return (
    <div className="rv-report">
      <label>
        <span className="rv-label">{t("rv.reason")}</span>
        <textarea rows={2} maxLength={1000} value={reason} onChange={(e) => setReason(e.target.value)} placeholder={t("rv.reason_placeholder")} />
      </label>
      {media.length > 0 && (
        <label className="rv-select">
          <span className="rv-label">{t("rv.about")}</span>
          <select value={mediaId} onChange={(e) => setMediaId(e.target.value)}>
            <option value="">{t("rv.whole_review")}</option>
            {media.map((m, i) => <option key={m.id} value={m.id}>{fmt(t("rv.image_n"), { n: i + 1 })}</option>)}
          </select>
        </label>
      )}
      {error && <p className="rv-error" role="alert">{"api" in error ? reviewErrorMessageIn(error.api, lang, (e) => apiErrorMessage(e, lang)) : t(error.key)}</p>}
      <button type="button" className="rv-pill is-on" onClick={send} disabled={busy}>{busy ? t("rv.sending") : t("rv.send_report")}</button>
    </div>
  );
}

function HelpfulIcon() {
  return (
    <svg viewBox="0 0 20 20" width="15" height="15" aria-hidden="true">
      <path d="M6.5 8.5 9.4 3c1.3 0 2.1 1 1.9 2.3l-.4 2.6h4.3c1.1 0 1.9 1 1.7 2l-1.1 5.6c-.2.8-.9 1.4-1.7 1.4H6.5m0-8.4v8.4m0-8.4H4a1 1 0 0 0-1 1v6.4a1 1 0 0 0 1 1h2.5" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" />
    </svg>
  );
}

/** A quiet full-screen viewer for a review's images (keyboard: ← → Esc). */
function MediaViewer({ media, index, onClose }: { media: ReviewMediaDto[]; index: number; onClose: () => void }) {
  const lang: Lang = useLang();
  const t = (key: string) => translate(lang, key);
  const [i, setI] = useState(index);
  const closeRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    closeRef.current?.focus();
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
      // RTL: the left arrow moves forward; LTR (English): the right arrow does.
      const forward = document.documentElement.dir === "ltr" ? "ArrowRight" : "ArrowLeft";
      const back = forward === "ArrowLeft" ? "ArrowRight" : "ArrowLeft";
      if (e.key === forward) setI((x) => Math.min(media.length - 1, x + 1));
      if (e.key === back) setI((x) => Math.max(0, x - 1));
    };
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = previous;
      opener?.focus?.();
    };
  }, [media.length, onClose]);
  const m = media[i];
  return (
    <div className="rv-viewer" role="dialog" aria-modal="true" aria-label={t("rv.images")} onMouseDown={onClose}>
      <figure onMouseDown={(e) => e.stopPropagation()}>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={m.url} alt={m.alt_text ?? t("rv.image_alt")} />
        <figcaption>
          {m.alt_text && <span>{m.alt_text}</span>}
          <span className="rv-viewer-count">{i + 1} / {media.length}</span>
        </figcaption>
        <button ref={closeRef} type="button" className="rv-viewer-close" onClick={onClose} aria-label={t("rv.close")}>×</button>
        {media.length > 1 && (
          <>
            <button type="button" className="rv-viewer-nav is-prev" onClick={() => setI(Math.max(0, i - 1))} disabled={i === 0} aria-label={t("rv.prev_image")}>›</button>
            <button type="button" className="rv-viewer-nav is-next" onClick={() => setI(Math.min(media.length - 1, i + 1))} disabled={i === media.length - 1} aria-label={t("rv.next_image")}>‹</button>
          </>
        )}
      </figure>
    </div>
  );
}
