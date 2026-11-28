"use client";

import "@/lib/approvalCenterText";
import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import { EmptyState, ErrorBanner } from "@/components/States";
import { apiFetch } from "@/lib/api";
import { apiErrorMessage } from "@/lib/apiErrors";
import { fill } from "@/lib/approvalCenterText";
import type { Lang } from "@/lib/i18n";
import { useAdminGate } from "@/lib/useAdminGate";
import { useLang, useT } from "@/lib/useLang";
import styles from "./approvals.module.css";

// VIA Control Center phase 2B - the Approval Center. An inbox over the
// seven sources' EXISTING reads; it never decides, copies or stores a
// request. Counts come from GET /admin/approval-center/summary (only the
// sources this role may use, only what this user may decide); each tab
// lists its source's own pending items, oldest first, and links to the
// source's own decision screen.

type SourceKey =
  | "BRANCH_VERIFICATION"
  | "WAREHOUSE_VERIFICATION"
  | "NAME_CHANGE"
  | "BRAND_REQUEST"
  | "REPORTED_REVIEW"
  | "ESCALATED_RETURN"
  | "SIZE_GUIDE_REQUEST";

interface SourceSummary {
  source: SourceKey;
  status: "AVAILABLE" | "UNAVAILABLE";
  pending: number | null;
  oldest_at: string | null;
  excluded_self?: number;
}
interface Summary {
  role: "PLATFORM_ADMIN" | "VERIFICATION_REVIEWER";
  generated_at: string;
  sources: SourceSummary[];
  total: number;
  partial: boolean;
}

/** One list row, whatever the source. */
interface Row {
  id: string;
  primary: string;
  secondary?: string | null;
  related?: string | null;
  status: string;
  since: string | null;
  href: string;
  stage?: string;
}

/** Each source's own decision screen. */
const DECISION_PAGE: Record<SourceKey, string> = {
  BRANCH_VERIFICATION: "/admin/verification",
  WAREHOUSE_VERIFICATION: "/admin/verification",
  NAME_CHANGE: "/admin/name-change-requests",
  BRAND_REQUEST: "/admin/brands/requests",
  REPORTED_REVIEW: "/admin/reviews",
  ESCALATED_RETURN: "/admin/returns",
  SIZE_GUIDE_REQUEST: "/admin/size-guides/requests",
};

/** The brand list's own server-side cap (BrandRequestsService.listForAdmin). */
const BRAND_LIST_CAP = 200;

type T = (key: string) => string;

function formatTime(iso: string | null, lang: Lang): string {
  if (!iso) return "-";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "-";
  return d.toLocaleString(lang === "ar" ? "ar" : "en-GB", { dateStyle: "medium", timeStyle: "short" });
}

interface QueueItem {
  kind: "BRANCH" | "WAREHOUSE";
  item_id: string;
  vendor_id: string;
  legal_name: string;
  store_type: string;
  vendor_status: string;
  submitted_at: string;
  branch_name?: string | null;
}
interface NameChange {
  id: string;
  canonical_product_id: string;
  requested_name_ar: string;
  requested_name_en: string;
  reason: string | null;
  created_at: string;
}
interface BrandRequest {
  id: string;
  name: string;
  offer: { id: string; title_ar: string } | null;
  vendor: { id: string; name: string };
  created_at: string;
}
interface ReportedReview {
  id: string;
  target_type: "PRODUCT" | "STORE";
  rating: number;
  body: string;
  author: string;
  store: { name: string } | null;
  pending_reports: { created_at: string }[];
}
interface EscalatedReturn {
  id: string;
  reason: string;
  reason_note: string | null;
  escalated_at: string | null;
  created_at: string;
}
interface SizeGuideRequest {
  id: string;
  message: string;
  created_at: string;
  offer?: { title: string; store: string };
}

interface Loaded {
  rows: Row[];
  next: string | null;
  capped?: number;
}

/** Loads one page of a source's pending items from its own existing API. */
async function loadSource(source: SourceKey, cursor: string | null, t: T): Promise<Loaded> {
  switch (source) {
    case "BRANCH_VERIFICATION":
    case "WAREHOUSE_VERIFICATION": {
      const qs = new URLSearchParams({
        status: "pending",
        kind: source === "BRANCH_VERIFICATION" ? "BRANCH" : "WAREHOUSE",
        limit: "50",
      });
      if (cursor) qs.set("cursor", cursor);
      const page = await apiFetch<{ items: QueueItem[]; next_cursor: string | null }>(`/admin/verification-queue?${qs}`);
      return {
        next: page.next_cursor,
        rows: page.items.map((q) => ({
          id: q.item_id,
          primary: q.legal_name,
          secondary: q.kind === "BRANCH" ? fill(t("ac.branch"), { name: q.branch_name ?? "" }) : t("ac.warehouse"),
          related: t(`ac.store_type.${q.store_type}`),
          status: t("ac.status.PENDING"),
          since: q.submitted_at,
          href: `/admin/verification/${q.vendor_id}`,
          stage: q.vendor_status,
        })),
      };
    }
    case "NAME_CHANGE": {
      const items = await apiFetch<NameChange[]>("/canonical-products/name-change-requests");
      return {
        next: null,
        rows: items.map((r) => ({
          id: r.id,
          primary: fill(t("ac.rename"), { ar: r.requested_name_ar, en: r.requested_name_en }),
          secondary: r.reason,
          related: `#${r.canonical_product_id.slice(0, 8)}`,
          status: t("ac.status.PENDING"),
          since: r.created_at,
          href: DECISION_PAGE.NAME_CHANGE,
        })),
      };
    }
    case "BRAND_REQUEST": {
      const page = await apiFetch<{ items: BrandRequest[] }>("/admin/brand-requests?status=PENDING");
      return {
        next: null,
        capped: page.items.length >= BRAND_LIST_CAP ? BRAND_LIST_CAP : undefined,
        rows: page.items.map((r) => ({
          id: r.id,
          primary: r.name,
          secondary: r.offer ? fill(t("ac.brand_for"), { title: r.offer.title_ar }) : null,
          related: r.vendor.name,
          status: t("ac.status.PENDING"),
          since: r.created_at,
          href: DECISION_PAGE.BRAND_REQUEST,
        })),
      };
    }
    case "REPORTED_REVIEW": {
      const items = await apiFetch<ReportedReview[]>("/admin/reviews/reported");
      return {
        next: null,
        rows: items.map((r) => ({
          id: r.id,
          primary: r.body,
          secondary: `${t(`ac.review_target.${r.target_type}`)} · ${fill(t("ac.rating"), { n: r.rating })} · ${r.author}`,
          related: r.store?.name ?? null,
          status: fill(t("ac.status.REPORTED"), { n: r.pending_reports.length }),
          since: r.pending_reports[0]?.created_at ?? null,
          href: DECISION_PAGE.REPORTED_REVIEW,
        })),
      };
    }
    case "ESCALATED_RETURN": {
      const items = await apiFetch<EscalatedReturn[]>("/admin/returns");
      return {
        next: null,
        rows: items.map((r) => ({
          id: r.id,
          primary: fill(t("ac.return"), { id: `#${r.id.slice(0, 8)}` }),
          secondary: [t(`ac.return.reason.${r.reason}`), r.reason_note].filter(Boolean).join(" - "),
          related: null,
          status: t("ac.status.ESCALATED"),
          since: r.escalated_at ?? r.created_at,
          href: DECISION_PAGE.ESCALATED_RETURN,
        })),
      };
    }
    case "SIZE_GUIDE_REQUEST": {
      const items = await apiFetch<SizeGuideRequest[]>("/admin/size-guide-requests?status=PENDING");
      return {
        next: null,
        rows: items.map((r) => ({
          id: r.id,
          primary: r.message,
          secondary: r.offer?.title ?? null,
          related: r.offer?.store ?? null,
          status: t("ac.status.PENDING"),
          since: r.created_at,
          href: DECISION_PAGE.SIZE_GUIDE_REQUEST,
        })),
      };
    }
  }
}

export default function ApprovalCenterPage() {
  const gate = useAdminGate();
  const t = useT();
  const lang = useLang();

  const [summary, setSummary] = useState<Summary | null>(null);
  const [summaryError, setSummaryError] = useState<unknown>(null);
  const [summaryNonce, setSummaryNonce] = useState(0);
  const [selected, setSelected] = useState<SourceKey | null>(null);

  useEffect(() => {
    if (gate.status !== "ok") return;
    let cancelled = false;
    apiFetch<Summary>("/admin/approval-center/summary")
      .then((s) => {
        if (cancelled) return;
        setSummary(s);
        setSummaryError(null);
      })
      .catch((err) => {
        if (!cancelled) setSummaryError(err);
      });
    return () => {
      cancelled = true;
    };
  }, [gate.status, summaryNonce]);

  // Default tab: the first source with something waiting, else the first.
  const current: SourceKey | null =
    selected ??
    summary?.sources.find((s) => (s.pending ?? 0) > 0)?.source ??
    summary?.sources[0]?.source ??
    null;
  const currentSummary = summary?.sources.find((s) => s.source === current) ?? null;

  if (gate.status === "loading") {
    return (
      <div className="page-shell">
        <div className="skeleton" style={{ height: 160, width: "100%", maxWidth: 1100 }} />
      </div>
    );
  }
  if (gate.status === "forbidden") {
    return (
      <div className="page-shell">
        <EmptyState title={t("ac.forbidden")} actionHref="/account" actionLabel={t("ac.account")} />
      </div>
    );
  }

  return (
    <div className="page-shell">
      <div className="wide-shell" style={{ maxWidth: 1100 }}>
        <div className="top-bar">
          <div>
            <h1 className="page-title" style={{ margin: 0 }}>
              {t("ac.title")}
            </h1>
          </div>
          <button type="button" className="button-link" onClick={() => setSummaryNonce((n) => n + 1)}>
            {t("ac.refresh")}
          </button>
        </div>
        <p className={styles.lead}>{t("ac.lead")}</p>

        {summaryError !== null && !summary && (
          <div className={styles.summaryError}>
            <ErrorBanner message={`${t("ac.summary_failed")} ${apiErrorMessage(summaryError, lang)}`} />
            <button type="button" className="button" onClick={() => setSummaryNonce((n) => n + 1)}>
              {t("ac.retry")}
            </button>
          </div>
        )}

        {!summary && summaryError === null && <div className="skeleton" style={{ height: 120, width: "100%" }} />}

        {summary && (
          <>
            <div className={styles.totalRow}>
              <strong className={styles.total} data-testid="ac-total">
                {fill(t("ac.total"), { n: summary.total })}
              </strong>
              <span className={styles.updated}>{fill(t("ac.updated"), { time: formatTime(summary.generated_at, lang) })}</span>
            </div>
            {summary.partial && (
              <div className="warning-banner" role="status" data-testid="ac-partial">
                {t("ac.total_partial")}
              </div>
            )}

            <div className={styles.tabs} role="tablist" aria-label={t("ac.sources_aria")}>
              {summary.sources.map((s) => {
                const isCurrent = s.source === current;
                const unavailable = s.status === "UNAVAILABLE";
                return (
                  <button
                    key={s.source}
                    type="button"
                    role="tab"
                    id={`ac-tab-${s.source}`}
                    aria-selected={isCurrent}
                    aria-controls="ac-panel"
                    className={`${styles.tab}${isCurrent ? ` ${styles.tabActive}` : ""}${unavailable ? ` ${styles.tabUnavailable}` : ""}`}
                    onClick={() => setSelected(s.source)}
                    data-testid={`ac-tab-${s.source}`}
                    data-status={s.status}
                    data-pending={s.pending ?? ""}
                  >
                    <span className={styles.tabLabel}>{t(`ac.source.${s.source}`)}</span>
                    {unavailable ? (
                      <span className={styles.tabUnavailableText}>{t("ac.unavailable")}</span>
                    ) : (
                      <span className={`${styles.tabCount}${s.pending === 0 ? ` ${styles.tabCountZero}` : ""}`}>{s.pending}</span>
                    )}
                    <span className={styles.tabMeta}>
                      {unavailable
                        ? t("ac.retry")
                        : s.pending && s.oldest_at
                          ? fill(t("ac.oldest"), { time: formatTime(s.oldest_at, lang) })
                          : t("ac.none_waiting")}
                    </span>
                  </button>
                );
              })}
            </div>

            {current && currentSummary && (
              <SourcePanel
                key={`${current}:${summaryNonce}`}
                source={current}
                summary={currentSummary}
                onRetrySummary={() => setSummaryNonce((n) => n + 1)}
              />
            )}
          </>
        )}
      </div>
    </div>
  );
}

function SourcePanel({
  source,
  summary,
  onRetrySummary,
}: {
  source: SourceKey;
  summary: SourceSummary;
  onRetrySummary: () => void;
}) {
  const t = useT();
  const lang = useLang();
  const [rows, setRows] = useState<Row[] | null>(null);
  const [next, setNext] = useState<string | null>(null);
  const [capped, setCapped] = useState<number | undefined>(undefined);
  const [error, setError] = useState<unknown>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [query, setQuery] = useState("");
  const [stage, setStage] = useState<"all" | "UNDER_REVIEW" | "ACTIVE">("all");
  const isVerification = source === "BRANCH_VERIFICATION" || source === "WAREHOUSE_VERIFICATION";

  useEffect(() => {
    let cancelled = false;
    loadSource(source, null, t)
      .then((r) => {
        if (cancelled) return;
        setRows(r.rows);
        setNext(r.next);
        setCapped(r.capped);
        setError(null);
      })
      .catch((err) => {
        if (!cancelled) setError(err);
      });
    return () => {
      cancelled = true;
    };
    // The row texts follow the language; re-read when it changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [source, attempt, lang]);

  const loadMore = useCallback(async () => {
    if (!next) return;
    setLoadingMore(true);
    try {
      const r = await loadSource(source, next, t);
      setRows((prev) => [...(prev ?? []), ...r.rows]);
      setNext(r.next);
    } catch (err) {
      setError(err);
    } finally {
      setLoadingMore(false);
    }
  }, [next, source, t]);

  const visible = useMemo(() => {
    if (!rows) return [];
    const q = query.trim().toLowerCase();
    return rows.filter((r) => {
      if (isVerification && stage !== "all" && r.stage !== stage) return false;
      if (!q) return true;
      return [r.primary, r.secondary, r.related].some((v) => v?.toLowerCase().includes(q));
    });
  }, [rows, query, stage, isVerification]);

  return (
    <section
      id="ac-panel"
      role="tabpanel"
      aria-labelledby={`ac-tab-${source}`}
      className={styles.panel}
      data-testid="ac-panel"
    >
      <div className={styles.panelHead}>
        <h2 className={styles.panelTitle}>{t(`ac.source.${source}`)}</h2>
        <Link href={DECISION_PAGE[source]} className="button-link" data-testid="ac-open-source">
          {t("ac.open_source")}
        </Link>
      </div>

      {summary.status === "UNAVAILABLE" && (
        <div className={styles.unavailable} data-testid="ac-source-unavailable">
          <span>{t("ac.source_unavailable")}</span>
          <button type="button" className="button" onClick={onRetrySummary}>
            {t("ac.retry")}
          </button>
        </div>
      )}

      {source === "ESCALATED_RETURN" && (summary.excluded_self ?? 0) > 0 && (
        <div className="notice-banner" data-testid="ac-excluded-self">
          {fill(t("ac.excluded_self"), { n: summary.excluded_self ?? 0 })}
        </div>
      )}

      {summary.status === "AVAILABLE" && (
        <>
          <div className={styles.filters}>
            <div className="field">
              <label htmlFor="ac-search">{t("ac.search")}</label>
              <input
                id="ac-search"
                type="search"
                value={query}
                placeholder={t("ac.search_placeholder")}
                onChange={(e) => setQuery(e.target.value)}
              />
            </div>
            {isVerification && (
              <div className="field">
                <label htmlFor="ac-stage">{t("ac.filter_stage")}</label>
                <select id="ac-stage" value={stage} onChange={(e) => setStage(e.target.value as typeof stage)}>
                  <option value="all">{t("ac.stage.all")}</option>
                  <option value="UNDER_REVIEW">{t("ac.stage.initial")}</option>
                  <option value="ACTIVE">{t("ac.stage.late")}</option>
                </select>
              </div>
            )}
          </div>

          {error !== null && (
            <div className={styles.unavailable}>
              <span>
                {t("ac.list_failed")} {apiErrorMessage(error, lang)}
              </span>
              <button type="button" className="button" onClick={() => setAttempt((a) => a + 1)}>
                {t("ac.retry")}
              </button>
            </div>
          )}

          {rows === null && error === null && (
            <div aria-busy="true">
              <div className="skeleton" style={{ height: 64, width: "100%", marginBottom: 8 }} />
              <div className="skeleton" style={{ height: 64, width: "100%" }} />
            </div>
          )}

          {rows !== null && (
            <>
              {rows.length === 0 ? (
                <p className={styles.empty} data-testid="ac-empty">
                  {t("ac.empty")}
                </p>
              ) : visible.length === 0 ? (
                <p className={styles.empty}>{t("ac.empty_filtered")}</p>
              ) : (
                <ol className={styles.list} data-testid="ac-list">
                  <li className={styles.listHead} aria-hidden="true">
                    <span>{t("ac.col.item")}</span>
                    <span>{t("ac.col.related")}</span>
                    <span>{t("ac.col.status")}</span>
                    <span>{t("ac.col.since")}</span>
                    <span />
                  </li>
                  {visible.map((r) => (
                    <li key={r.id} className={styles.row} data-testid="ac-row" data-id={r.id}>
                      <div className={styles.rowMain}>
                        <strong className={styles.rowPrimary}>{r.primary}</strong>
                        {r.secondary && <span className={styles.rowSecondary}>{r.secondary}</span>}
                      </div>
                      <span className={styles.rowRelated}>{r.related ?? "-"}</span>
                      <span className={styles.rowStatus}>
                        <span className="badge">{r.status}</span>
                        {r.stage === "ACTIVE" && <span className="badge badge-active">{t("ac.vendor.ACTIVE")}</span>}
                      </span>
                      <span className={styles.rowSince}>{formatTime(r.since, lang)}</span>
                      <Link href={r.href} className="button-link">
                        {t("ac.open_item")}
                      </Link>
                    </li>
                  ))}
                </ol>
              )}
              <div className={styles.listFoot}>
                {next && summary.pending !== null && (
                  <span>{fill(t("ac.showing"), { shown: rows.length, total: summary.pending })}</span>
                )}
                {capped && <span>{fill(t("ac.capped"), { n: capped })}</span>}
                {next && (
                  <button type="button" className="button button-secondary" onClick={() => void loadMore()} disabled={loadingMore}>
                    {t("ac.load_more")}
                  </button>
                )}
              </div>
            </>
          )}
        </>
      )}
    </section>
  );
}
