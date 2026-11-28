"use client";

import "@/lib/offerModerationText";
import Link from "next/link";
import { FormEvent, useCallback, useEffect, useState } from "react";
import { EmptyState } from "@/components/States";
import { apiFetch } from "@/lib/api";
import { apiErrorMessage } from "@/lib/apiErrors";
import { useAdminGate } from "@/lib/useAdminGate";
import { useLang, useT } from "@/lib/useLang";
import styles from "../approvals/approvals.module.css";

// VIA phase 2C - offer moderation (Marketplace): every offer with its
// platform hold state, searchable and filterable; each opens its detail
// page, where the hold decisions are made. PLATFORM_ADMIN only.

interface Hold {
  action: "HIDE" | "REQUEST_CHANGES";
  reason: string;
  placed_at: string;
  correction: { revision: number; stale: boolean } | null;
}
interface Row {
  id: string;
  title_ar: string;
  title_en: string;
  status: "DRAFT" | "ACTIVE" | "INACTIVE" | "ARCHIVED";
  store: { id: string; name: string; slug: string };
  image_url: string | null;
  created_at: string;
  hold: Hold | null;
}

const HOLD_FILTERS = ["all", "held", "none", "HIDE", "REQUEST_CHANGES", "correction_submitted"] as const;
const STATUS_FILTERS = ["all", "DRAFT", "ACTIVE", "INACTIVE", "ARCHIVED"] as const;

export default function AdminOffersPage() {
  const gate = useAdminGate("ADMIN");
  const t = useT();
  const lang = useLang();
  const [draft, setDraft] = useState({ q: "", hold: "all", status: "all" });
  const [filters, setFilters] = useState(draft);
  const [rows, setRows] = useState<Row[] | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [attempt, setAttempt] = useState(0);

  const query = useCallback(
    (after: string | null) => {
      const qs = new URLSearchParams({ limit: "25" });
      if (filters.q.trim()) qs.set("q", filters.q.trim());
      if (filters.hold !== "all") qs.set("hold", filters.hold);
      if (filters.status !== "all") qs.set("status", filters.status);
      if (after) qs.set("cursor", after);
      return apiFetch<{ items: Row[]; next_cursor: string | null }>(`/admin/offers?${qs}`);
    },
    [filters],
  );

  useEffect(() => {
    if (gate.status !== "ok") return;
    let cancelled = false;
    query(null)
      .then((page) => {
        if (cancelled) return;
        setRows(page.items);
        setCursor(page.next_cursor);
      })
      .catch((err) => {
        if (!cancelled) setError(err);
      });
    return () => {
      cancelled = true;
    };
  }, [gate.status, query, attempt]);

  async function more() {
    if (!cursor) return;
    setLoadingMore(true);
    try {
      const page = await query(cursor);
      setRows((prev) => [...(prev ?? []), ...page.items]);
      setCursor(page.next_cursor);
    } catch (err) {
      setError(err);
    } finally {
      setLoadingMore(false);
    }
  }

  /** A new query starts from an empty, loading list. */
  function load(next: typeof filters) {
    setRows(null);
    setError(null);
    setCursor(null);
    setFilters(next);
    setAttempt((a) => a + 1);
  }

  function apply(e: FormEvent) {
    e.preventDefault();
    load({ ...draft });
  }

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
        <EmptyState title={t("om.forbidden")} actionHref="/account" actionLabel={t("om.account")} />
      </div>
    );
  }

  const title = (r: Row) => (lang === "en" && r.title_en ? r.title_en : r.title_ar);
  const time = (iso: string) =>
    new Date(iso).toLocaleString(lang === "ar" ? "ar" : "en-GB", { dateStyle: "medium" });

  return (
    <div className="page-shell">
      <div className="wide-shell" style={{ maxWidth: 1100 }}>
        <div className="top-bar">
          <h1 className="page-title" style={{ margin: 0 }}>
            {t("om.title")}
          </h1>
        </div>
        <p className={styles.lead}>{t("om.lead")}</p>

        <form className={`${styles.panel} ${styles.filters}`} onSubmit={apply} style={{ marginBottom: 16 }}>
          <div className="field">
            <label htmlFor="om-q">{t("om.search")}</label>
            <input
              id="om-q"
              type="search"
              value={draft.q}
              placeholder={t("om.search_placeholder")}
              onChange={(e) => setDraft({ ...draft, q: e.target.value })}
            />
          </div>
          <div className="field">
            <label htmlFor="om-hold">{t("om.filter_hold")}</label>
            <select id="om-hold" value={draft.hold} onChange={(e) => setDraft({ ...draft, hold: e.target.value })}>
              {HOLD_FILTERS.map((h) => (
                <option key={h} value={h}>
                  {t(`om.hold.${h}`)}
                </option>
              ))}
            </select>
          </div>
          <div className="field">
            <label htmlFor="om-status">{t("om.filter_status")}</label>
            <select id="om-status" value={draft.status} onChange={(e) => setDraft({ ...draft, status: e.target.value })}>
              {STATUS_FILTERS.map((s) => (
                <option key={s} value={s}>
                  {t(`om.status.${s}`)}
                </option>
              ))}
            </select>
          </div>
          <div style={{ display: "flex", gap: 8, alignItems: "end", flexWrap: "wrap" }}>
            <button type="submit" className="button" data-testid="om-apply">
              {t("om.apply")}
            </button>
            <button
              type="button"
              className="button button-secondary"
              onClick={() => {
                const reset = { q: "", hold: "all", status: "all" };
                setDraft(reset);
                load(reset);
              }}
            >
              {t("om.reset")}
            </button>
          </div>
        </form>

        {error !== null && (
          <div className={styles.unavailable}>
            <span>
              {t("om.load_failed")} {apiErrorMessage(error, lang)}
            </span>
            <button type="button" className="button" onClick={() => load(filters)}>
              {t("om.retry")}
            </button>
          </div>
        )}
        {rows === null && error === null && (
          <div aria-busy="true">
            <div className="skeleton" style={{ height: 64, width: "100%", marginBottom: 8 }} />
            <div className="skeleton" style={{ height: 64, width: "100%" }} />
          </div>
        )}
        {rows !== null && rows.length === 0 && <p className={styles.empty}>{t("om.empty")}</p>}
        {rows !== null && rows.length > 0 && (
          <ol className={styles.list} data-testid="om-list">
            <li className={styles.listHead} aria-hidden="true">
              <span>{t("om.col.offer")}</span>
              <span>{t("om.col.store")}</span>
              <span>{t("om.col.status")}</span>
              <span>{t("om.col.moderation")}</span>
              <span />
            </li>
            {rows.map((r) => (
              <li key={r.id} className={styles.row} data-testid="om-row" data-id={r.id}>
                <div className={styles.rowMain}>
                  <strong className={styles.rowPrimary}>{title(r)}</strong>
                  <span className={styles.rowSecondary}>{time(r.created_at)}</span>
                </div>
                <span className={styles.rowRelated}>{r.store.name}</span>
                <span className={styles.rowStatus}>
                  <span className={`badge${r.status === "ACTIVE" ? " badge-active" : ""}`}>{t(`om.status.${r.status}`)}</span>
                </span>
                <span className={styles.rowStatus} data-testid="om-row-hold">
                  {r.hold ? (
                    <>
                      <span className="badge" style={{ background: "var(--color-danger-bg)", color: "var(--color-danger)" }}>
                        {t(`om.hold.${r.hold.action}`)}
                      </span>
                      {r.hold.correction && (
                        <span className="badge">{r.hold.correction.stale ? t("om.stale_badge") : t("om.correction_badge")}</span>
                      )}
                    </>
                  ) : (
                    <span className="badge">{t("om.not_held")}</span>
                  )}
                </span>
                <Link href={`/admin/offers/${r.id}`} className="button-link">
                  {t("om.open")}
                </Link>
              </li>
            ))}
          </ol>
        )}
        {cursor && (
          <div className={styles.listFoot}>
            <button type="button" className="button button-secondary" disabled={loadingMore} onClick={() => void more()}>
              {t("om.load_more")}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
