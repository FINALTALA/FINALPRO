"use client";

import Link from "next/link";
import { useParams, usePathname, useRouter, useSearchParams } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { useBranchWorkspace } from "@/components/owner/BranchWorkspace";
import OnlineSalesSection from "@/components/performance/OnlineSalesSection";
import OwnerReviewsSection from "@/components/performance/OwnerReviewsSection";
import PerformanceSection from "@/components/performance/PerformanceSection";
import StoreSalesLog from "@/components/pos/StoreSalesLog";
import { EmptyState } from "@/components/States";
import { ApiError, apiFetch } from "@/lib/api";
import { loginRedirectHref } from "@/lib/loginRedirect";
import "@/lib/performanceText";
import { useT } from "@/lib/useLang";

const VIEWS = ["overview", "sales", "customers", "tools"] as const;
type View = (typeof VIEWS)[number];
const SECTIONS = ["online", "store-sales"];

/**
 * «أداء المتجر» (2026-11-23): ONE owner screen in the store's management
 * window instead of five cards - «نظرة عامة» (the performance indicators, or
 * «غير متاحة» while their flag is off - the rest still works), «المبيعات»
 * (online in the last 30 days, the shop's sales log), «العملاء» (the store's
 * reviews), «أدوات سريعة» (labels and the cashier, opened in the same window
 * with «رجوع» back here; the public reviews page). The view is in the URL
 * (?view=), so a link or «رجوع» opens exactly it. Same APIs, same rights:
 * OWNER only - every API refuses anyone else anyway.
 */
export default function StorePerformancePage() {
  const params = useParams<{ vendorId: string }>();
  const vendorId = params.vendorId;
  const router = useRouter();
  const pathname = usePathname();
  const sp = useSearchParams();
  const t = useT();
  const ws = useBranchWorkspace(vendorId);
  const raw = sp.get("view");
  const view: View = (VIEWS as readonly string[]).includes(raw ?? "") ? (raw as View) : "overview";
  /** the cashier flag: the shop's sales log and the shop tools follow it (null = not known yet) */
  const [cashier, setCashier] = useState<boolean | null>(null);
  const [slug, setSlug] = useState<string | null>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const firstView = useRef(view);

  useEffect(() => {
    if (ws.hydrated && !ws.token) router.replace(loginRedirectHref());
  }, [ws.hydrated, ws.token, router]);

  useEffect(() => {
    if (!ws.isOwner) return;
    let alive = true;
    apiFetch(`/vendors/${vendorId}/cashier`).then(
      () => alive && setCashier(true),
      // only «turned off» hides the shop parts; another failure is shown by the log itself
      (err: unknown) => alive && setCashier(!(err instanceof ApiError && err.code === "FEATURE_DISABLED")),
    );
    apiFetch<{ slug: string }>(`/vendors/${vendorId}/storefront`).then(
      (s) => alive && setSlug(s.slug),
      () => undefined,
    );
    return () => {
      alive = false;
    };
  }, [vendorId, ws.isOwner]);

  // a new view: its heading takes the focus (not on the first load)
  useEffect(() => {
    if (view !== firstView.current) {
      firstView.current = view;
      headingRef.current?.focus();
    }
  }, [view]);
  // an old address's #section (/sales, /store-sales) is brought into view
  useEffect(() => {
    if (!ws.ready || !ws.isOwner) return;
    const id = window.location.hash.slice(1);
    if (!SECTIONS.includes(id)) return;
    const h = window.setTimeout(() => {
      const el = document.getElementById(id);
      el?.scrollIntoView({ block: "start" });
      el?.focus({ preventScroll: true });
    }, 300);
    return () => window.clearTimeout(h);
  }, [ws.ready, ws.isOwner, view, cashier]);

  if (!ws.ready) return <div className="page-shell"><div className="skeleton" style={{ height: 220, width: "100%", maxWidth: 980 }} /></div>;
  if (!ws.isOwner) {
    return (
      <div className="page-shell">
        <EmptyState title={t("pf.owner_only")} actionHref="/account" actionLabel={t("pf.my_account")} />
      </div>
    );
  }

  const viewHref = (v: View) => (v === "overview" ? pathname : `${pathname}?view=${v}`);
  return (
    <div className="page-shell owner-performance pf" data-testid="store-performance">
      <header className="pf-head">
        <h1 className="pf-title">{t("pf.title")}</h1>
        <p className="muted pf-lead">{t("pf.lead")}</p>
      </header>
      <nav className="pf-views" aria-label={t("pf.views")} data-testid="pf-views">
        {VIEWS.map((v) => (
          <Link key={v} href={viewHref(v)} replace scroll={false} className={`pf-view${view === v ? " is-on" : ""}`} aria-current={view === v ? "page" : undefined} data-testid={`pf-view-${v}`}>
            {t(`pf.view.${v}`)}
          </Link>
        ))}
      </nav>

      <div className="pf-body">
        <h2 className="pf-view-title" ref={headingRef} tabIndex={-1} data-testid="pf-view-title">{t(`pf.view.${view}`)}</h2>

        {view === "overview" && (
          <>
            <p className="muted owner-performance-note">{t("pf.overview.note")}</p>
            <PerformanceSection
              vendorId={vendorId}
              whenDisabled={
                <div className="card perf-card perf-disabled" role="status" data-testid="pf-kpis-off">
                  <h3 style={{ marginTop: 0 }}>{t("pf.disabled.title")}</h3>
                  <p className="muted" style={{ margin: 0 }}>{t("pf.disabled.body")}</p>
                </div>
              }
            />
            <section className="pf-part" aria-labelledby="pf-go-title">
              <h3 className="pf-part-title" id="pf-go-title">{t("pf.overview.go")}</h3>
              <ul className="pf-go">
                {(["sales", "customers", "tools"] as const).map((v) => (
                  <li key={v}>
                    <Link href={viewHref(v)} replace scroll={false} className="pf-go-link" data-testid={`pf-go-${v}`}>
                      <strong>{t(`pf.view.${v}`)}</strong>
                      <span className="muted">{t(`pf.overview.go.${v}`)}</span>
                    </Link>
                  </li>
                ))}
              </ul>
            </section>
          </>
        )}

        {view === "sales" && (
          <>
            <OnlineSalesSection vendorId={vendorId} />
            {cashier === true && (
              <section className="pf-part" id="store-sales" aria-labelledby="pf-store-title" tabIndex={-1} data-testid="pf-store-sales">
                <h3 className="pf-part-title" id="pf-store-title">{t("pf.store.title")}</h3>
                <p className="muted pf-lead">{t("pf.store.lead")}</p>
                <StoreSalesLog vendorId={vendorId} embedded />
              </section>
            )}
            {cashier === false && <p className="muted" data-testid="pf-store-off">{t("pf.store.off")}</p>}
          </>
        )}

        {view === "customers" && <OwnerReviewsSection vendorId={vendorId} />}

        {view === "tools" && (
          <section className="pf-part" aria-describedby="pf-tools-lead">
            <p className="muted pf-lead" id="pf-tools-lead">{t("pf.tools.lead")}</p>
            <ul className="pf-tools" data-testid="pf-tools">
              {cashier === true && (
                <>
                  <li>
                    <Link href={`/vendor/${vendorId}/labels`} className="pf-tool" data-testid="pf-tool-labels">
                      <strong>{t("pf.tools.labels")}</strong>
                      <span className="muted">{t("pf.tools.labels_hint")}</span>
                    </Link>
                  </li>
                  <li>
                    <Link href={`/vendor/${vendorId}/cashier`} className="pf-tool" data-testid="pf-tool-cashier">
                      <strong>{t("pf.tools.cashier")}</strong>
                      <span className="muted">{t("pf.tools.cashier_hint")}</span>
                    </Link>
                  </li>
                </>
              )}
              {slug && (
                <li>
                  <a href={`/store/${slug}/reviews`} target="_blank" rel="noopener noreferrer" className="pf-tool" data-testid="pf-tool-public-reviews">
                    <strong>
                      {t("pf.tools.public_reviews")} <span className="visually-hidden">{t("pf.tools.new_window")}</span>
                    </strong>
                    <span className="muted">{t("pf.tools.public_reviews_hint")}</span>
                  </a>
                </li>
              )}
            </ul>
            {cashier === false && <p className="muted" data-testid="pf-tools-off">{t("pf.tools.cashier_off")}</p>}
          </section>
        )}
      </div>
    </div>
  );
}
