"use client";

import "@/lib/adminOrdersText";
import Link from "next/link";
import { FormEvent, useCallback, useEffect, useState } from "react";
import { EmptyState } from "@/components/States";
import { apiFetch } from "@/lib/api";
import {
  fill,
  formatMoney,
  ORDER_STATUSES,
  statusTone,
} from "@/lib/adminOrdersText";
import { apiErrorMessage } from "@/lib/apiErrors";
import { useAdminGate } from "@/lib/useAdminGate";
import { useLang, useT } from "@/lib/useLang";
import styles from "../approvals/approvals.module.css";

// VIA phase 2D - Admin Orders: every marketplace branch order, searchable
// and filterable, newest first; each opens its read-only detail page.
// PLATFORM_ADMIN only (the API enforces it too).

interface Row {
  id: string;
  number: string;
  customer_order_id: string;
  status: string;
  fulfilment_method: "PICKUP" | "DELIVERY";
  payment_method: "ONLINE" | "COD";
  total: number;
  refunded: number;
  item_count: number;
  cancelled_lines: number;
  open_returns: number;
  store: { id: string; name: string; slug: string };
  branch: { id: string; name: string };
  created_at: string;
}

const FLAGS = ["refunded", "open_return", "cancelled_item"] as const;
const EMPTY = {
  q: "",
  status: "all",
  fulfilment: "all",
  payment: "all",
  flag: "all",
  from: "",
  to: "",
};

export default function AdminOrdersPage() {
  const gate = useAdminGate("ADMIN");
  const t = useT();
  const lang = useLang();
  const [draft, setDraft] = useState(EMPTY);
  const [filters, setFilters] = useState(EMPTY);
  const [rows, setRows] = useState<Row[] | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [attempt, setAttempt] = useState(0);

  const query = useCallback(
    (after: string | null) => {
      const qs = new URLSearchParams({ limit: "25" });
      if (filters.q.trim()) qs.set("q", filters.q.trim());
      for (const k of ["status", "fulfilment", "payment", "flag"] as const) {
        if (filters[k] !== "all") qs.set(k, filters[k]);
      }
      if (filters.from) qs.set("from", filters.from);
      if (filters.to) qs.set("to", filters.to);
      if (after) qs.set("cursor", after);
      return apiFetch<{ items: Row[]; next_cursor: string | null }>(
        `/admin/orders?${qs}`,
      );
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

  function load(next: typeof EMPTY) {
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
        <div
          className="skeleton"
          style={{ height: 160, width: "100%", maxWidth: 1100 }}
        />
      </div>
    );
  }
  if (gate.status === "forbidden") {
    return (
      <div className="page-shell">
        <EmptyState
          title={t("ao.forbidden")}
          actionHref="/account"
          actionLabel={t("ao.account")}
        />
      </div>
    );
  }

  const time = (iso: string) =>
    new Date(iso).toLocaleString(lang === "ar" ? "ar" : "en-GB", {
      dateStyle: "medium",
      timeStyle: "short",
    });
  const select = (
    key: "status" | "fulfilment" | "payment" | "flag",
    options: readonly string[],
    prefix: string,
  ) => (
    <div className="field">
      <label htmlFor={`ao-${key}`}>{t(`ao.f.${key}`)}</label>
      <select
        id={`ao-${key}`}
        value={draft[key]}
        onChange={(e) => setDraft({ ...draft, [key]: e.target.value })}
      >
        <option value="all">{t("ao.f.all")}</option>
        {options.map((o) => (
          <option key={o} value={o}>
            {t(`${prefix}.${o}`)}
          </option>
        ))}
      </select>
    </div>
  );

  return (
    <div className="page-shell">
      <div className="wide-shell" style={{ maxWidth: 1100 }}>
        <div className="top-bar">
          <h1 className="page-title" style={{ margin: 0 }}>
            {t("ao.title")}
          </h1>
        </div>
        <p className={styles.lead}>{t("ao.lead")}</p>

        <form
          className={`${styles.panel} ${styles.filters}`}
          onSubmit={apply}
          style={{ marginBottom: 16 }}
        >
          <div className="field">
            <label htmlFor="ao-q">{t("ao.search")}</label>
            <input
              id="ao-q"
              type="search"
              value={draft.q}
              placeholder={t("ao.search_placeholder")}
              onChange={(e) => setDraft({ ...draft, q: e.target.value })}
            />
          </div>
          {select("status", ORDER_STATUSES, "ao.status")}
          {select("fulfilment", ["PICKUP", "DELIVERY"], "ao.fulfilment")}
          {select("payment", ["ONLINE", "COD"], "ao.payment")}
          {select("flag", FLAGS, "ao.flag")}
          <div className="field">
            <label htmlFor="ao-from">{t("ao.f.from")}</label>
            <input
              id="ao-from"
              type="date"
              value={draft.from}
              onChange={(e) => setDraft({ ...draft, from: e.target.value })}
            />
          </div>
          <div className="field">
            <label htmlFor="ao-to">{t("ao.f.to")}</label>
            <input
              id="ao-to"
              type="date"
              value={draft.to}
              onChange={(e) => setDraft({ ...draft, to: e.target.value })}
            />
          </div>
          <div
            style={{
              display: "flex",
              gap: 8,
              alignItems: "end",
              flexWrap: "wrap",
            }}
          >
            <button type="submit" className="button" data-testid="ao-apply">
              {t("ao.apply")}
            </button>
            <button
              type="button"
              className="button button-secondary"
              onClick={() => {
                setDraft(EMPTY);
                load(EMPTY);
              }}
            >
              {t("ao.reset")}
            </button>
          </div>
        </form>

        {error !== null && (
          <div className={styles.unavailable} role="alert">
            <span>
              {t("ao.load_failed")} {apiErrorMessage(error, lang)}
            </span>
            <button
              type="button"
              className="button"
              onClick={() => load(filters)}
            >
              {t("ao.retry")}
            </button>
          </div>
        )}
        {rows === null && error === null && (
          <div aria-busy="true">
            <div
              className="skeleton"
              style={{ height: 64, width: "100%", marginBottom: 8 }}
            />
            <div className="skeleton" style={{ height: 64, width: "100%" }} />
          </div>
        )}
        {rows !== null && rows.length === 0 && (
          <p className={styles.empty}>{t("ao.empty")}</p>
        )}
        {rows !== null && rows.length > 0 && (
          <ol className={styles.list} data-testid="ao-list">
            <li className={styles.listHead} aria-hidden="true">
              <span>{t("ao.col.order")}</span>
              <span>{t("ao.col.store")}</span>
              <span>{t("ao.col.status")}</span>
              <span>{t("ao.col.total")}</span>
              <span />
            </li>
            {rows.map((r) => (
              <li
                key={r.id}
                className={styles.row}
                data-testid="ao-row"
                data-id={r.id}
              >
                <div className={styles.rowMain}>
                  <strong className={styles.rowPrimary}>
                    <bdi>#{r.number}</bdi>
                  </strong>
                  <span className={styles.rowSecondary}>
                    {time(r.created_at)} ·{" "}
                    {t(`ao.fulfilment.${r.fulfilment_method}`)} ·{" "}
                    {t(`ao.payment.${r.payment_method}`)}
                  </span>
                </div>
                <span className={styles.rowRelated}>
                  {r.store.name}
                  <br />
                  <small>{r.branch.name}</small>
                </span>
                <span
                  className={styles.rowStatus}
                  style={{ display: "flex", flexWrap: "wrap", gap: 4 }}
                >
                  <span
                    className="badge"
                    style={statusTone(r.status)}
                    data-testid="ao-row-status"
                  >
                    {t(`ao.status.${r.status}`)}
                  </span>
                  {r.open_returns > 0 && (
                    <span className="badge">
                      {fill(t("ao.badge.returns"), { n: r.open_returns })}
                    </span>
                  )}
                  {r.cancelled_lines > 0 && (
                    <span className="badge">
                      {fill(t("ao.badge.cancelled_lines"), {
                        n: r.cancelled_lines,
                      })}
                    </span>
                  )}
                </span>
                <span className={styles.rowRelated}>
                  <bdi>{formatMoney(r.total, lang)}</bdi>
                  <br />
                  <small>
                    {fill(t("ao.items"), { n: r.item_count })}
                    {r.refunded > 0 && (
                      <>
                        {" "}
                        ·{" "}
                        {fill(t("ao.badge.refunded"), {
                          amount: formatMoney(r.refunded, lang),
                        })}
                      </>
                    )}
                  </small>
                </span>
                <Link href={`/admin/orders/${r.id}`} className="button-link">
                  {t("ao.open")}
                </Link>
              </li>
            ))}
          </ol>
        )}
        {cursor && (
          <div className={styles.listFoot}>
            <button
              type="button"
              className="button button-secondary"
              disabled={loadingMore}
              onClick={() => void more()}
            >
              {t("ao.load_more")}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
