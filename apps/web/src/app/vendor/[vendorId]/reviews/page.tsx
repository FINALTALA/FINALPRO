"use client";

import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { ReviewStars } from "@/components/ProductReviews";
import { EmptyState, ErrorBanner } from "@/components/States";
import { apiFetch } from "@/lib/api";
import { FIT_LABEL, purchasedLine, ReviewDto, reviewErrorMessage, TAG_LABEL } from "@/lib/reviews";
import { useHydrated, useSessionToken, useWorkspaces } from "@/lib/useSession";
import { loginRedirectHref } from "@/lib/loginRedirect";

interface OwnerReviewDto extends ReviewDto {
  product_name: string | null;
}
interface OwnerReviewsPage {
  aggregate: { average: number | null; count: number };
  reviews: OwnerReviewDto[];
  next_cursor: string | null;
}
type Tab = "ALL" | "PRODUCT" | "STORE";
const TAB_LABEL: Record<Tab, string> = { ALL: "الكل", PRODUCT: "تقييمات المنتجات", STORE: "تقييمات المتجر" };

// PD-3 (decision 11): the owner reads every review of what their store
// sold and of the store itself - read-only by design: a store never
// edits, deletes or hides a customer's review, and replies are a later,
// separately approved phase (PD-3R). A review the owner thinks breaks
// the rules is reported from the public product page like any other.
export default function OwnerReviewsPage() {
  const params = useParams<{ vendorId: string }>();
  const router = useRouter();
  const hydrated = useHydrated();
  const token = useSessionToken();
  const workspaces = useWorkspaces(token);
  const membership = workspaces?.find((w) => w.type === "vendor" && w.vendor_id === params.vendorId);
  const isOwner = membership?.type === "vendor" && membership.role === "OWNER";
  const [tab, setTab] = useState<Tab>("ALL");
  // Keyed by tab so a switch shows the skeleton until its first page arrives.
  const [loaded, setLoaded] = useState<{ tab: Tab; data: OwnerReviewsPage | null; error: string | null } | null>(null);
  const [items, setItems] = useState<OwnerReviewDto[]>([]);
  const [moreError, setMoreError] = useState<string | null>(null);
  const current = loaded?.tab === tab ? loaded : null;
  const data = current?.data ?? null;
  const error = current?.error ?? moreError;
  const [loadingMore, setLoadingMore] = useState(false);

  const path = (cursor: string | null) =>
    `/vendors/${params.vendorId}/product-reviews?limit=20${tab === "ALL" ? "" : `&target=${tab}`}${cursor ? `&cursor=${cursor}` : ""}`;

  useEffect(() => {
    if (!hydrated) return;
    if (!token) {
      router.replace(loginRedirectHref());
      return;
    }
    if (!isOwner) return;
    let cancelled = false;
    apiFetch<OwnerReviewsPage>(path(null))
      .then((res) => {
        if (cancelled) return;
        setItems(res.reviews);
        setLoaded({ tab, data: res, error: null });
      })
      .catch((err) => !cancelled && setLoaded({ tab, data: null, error: reviewErrorMessage(err) }));
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hydrated, token, isOwner, params.vendorId, tab]);

  async function more() {
    if (!data?.next_cursor) return;
    setLoadingMore(true);
    try {
      const res = await apiFetch<OwnerReviewsPage>(path(data.next_cursor));
      setLoaded({ tab, data: { ...res, aggregate: data.aggregate }, error: null });
      setItems((all) => [...all, ...res.reviews]);
    } catch (err) {
      setMoreError(reviewErrorMessage(err));
    } finally {
      setLoadingMore(false);
    }
  }

  if (!hydrated || !token || workspaces === null) {
    return <div className="page-shell"><div className="skeleton" style={{ height: 160, width: "100%", maxWidth: 900 }} /></div>;
  }
  if (!isOwner) {
    return (
      <div className="page-shell">
        <EmptyState title="هذه الصفحة لصاحب المتجر فقط" actionHref="/account" actionLabel="حسابي" />
      </div>
    );
  }

  return (
    <div className="page-shell owner-reviews">
      <div className="top-bar">
        <h1 className="page-title" style={{ margin: 0 }}>تقييمات العملاء</h1>
        <Link href={`/vendor/${params.vendorId}`} className="button-link">لوحة المتجر</Link>
      </div>
      <p className="muted owner-reviews-note">
        تقييمات موثّقة كتبها مشترون استلموا طلباتهم منكم. للقراءة فقط: لا يمكن للمتجر تعديل تقييم أو حذفه أو إخفاؤه،
        وإن رأيتم تقييماً مخالفاً فبلّغوا عنه من صفحة المنتج لتراجعه الإدارة.
      </p>

      <div className="rv-toolbar" role="tablist" aria-label="نوع التقييمات">
        {(Object.keys(TAB_LABEL) as Tab[]).map((t) => (
          <button key={t} type="button" role="tab" aria-selected={tab === t} className={`rv-pill${tab === t ? " is-on" : ""}`} onClick={() => setTab(t)}>
            {TAB_LABEL[t]}
          </button>
        ))}
      </div>

      {error && <ErrorBanner message={error} />}
      {!data && !error && <div className="skeleton" style={{ height: 160, width: "100%", maxWidth: 900 }} />}
      {data && (
        <>
          <div className="owner-reviews-score">
            {data.aggregate.average !== null ? (
              <>
                <strong>{data.aggregate.average.toFixed(1)}</strong>
                <ReviewStars value={data.aggregate.average} size="lg" />
                <span>من {data.aggregate.count} تقييم ظاهر</span>
              </>
            ) : (
              <span>{data.aggregate.count === 0 ? "لا توجد تقييمات بعد." : `يظهر المتوسط بعد 3 تقييمات على الأقل (الآن ${data.aggregate.count}).`}</span>
            )}
          </div>
          {items.length === 0 ? (
            <div className="rv-empty"><strong>لا توجد تقييمات {tab === "ALL" ? "" : `في «${TAB_LABEL[tab]}»`} بعد</strong></div>
          ) : (
            <ul className="rv-list">
              {items.map((r) => {
                const bought = purchasedLine(r.purchased);
                return (
                  <li key={r.id} className="rv-card">
                    <div className="rv-card-head">
                      <span className="rv-avatar" aria-hidden="true">{[...r.author][0]}</span>
                      <div className="rv-card-who">
                        <strong>{r.author}</strong>
                        <span className="rv-own">{r.target_type === "STORE" ? "عن المتجر" : r.product_name ?? "منتج"}</span>
                      </div>
                      <time dateTime={r.created_at}>
                        {new Date(r.created_at).toLocaleDateString("ar-EG", { year: "numeric", month: "short", day: "numeric" })}
                        {r.edited && <span className="rv-edited"> · معدّل</span>}
                      </time>
                    </div>
                    <ReviewStars value={r.rating} size="sm" />
                    {(bought || r.fit || r.returned) && (
                      <dl className="rv-facts">
                        {bought && <div><dd>{bought}</dd></div>}
                        {r.fit && r.fit !== "NOT_APPLICABLE" && <div><dt>الملاءمة:</dt><dd>{FIT_LABEL[r.fit]}</dd></div>}
                        {r.returned && <div className="rv-returned"><dd>تم إرجاعه</dd></div>}
                      </dl>
                    )}
                    {r.tags.length > 0 && <div className="rv-card-tags">{r.tags.map((t) => <span key={t} className="rv-tag">{TAG_LABEL[t]}</span>)}</div>}
                    <p className="rv-body">{r.body}</p>
                    {r.media.length > 0 && (
                      <div className="rv-card-media">
                        {r.media.map((m) => (
                          <a key={m.id} href={m.url} target="_blank" rel="noreferrer">
                            {/* eslint-disable-next-line @next/next/no-img-element */}
                            <img src={m.url} alt={m.alt_text ?? "صورة من تقييم عميل"} loading="lazy" />
                          </a>
                        ))}
                      </div>
                    )}
                    {r.helpful_count > 0 && <span className="rv-helpful-count">وجده {r.helpful_count} مفيداً</span>}
                  </li>
                );
              })}
            </ul>
          )}
          {data.next_cursor && (
            <button type="button" className="rv-more" onClick={more} disabled={loadingMore}>
              {loadingMore ? "جارٍ التحميل…" : "عرض المزيد"}
            </button>
          )}
        </>
      )}
    </div>
  );
}
