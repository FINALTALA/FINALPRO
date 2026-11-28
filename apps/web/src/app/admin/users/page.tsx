"use client";

import "@/lib/adminUsersText";
import Link from "next/link";
import { FormEvent, useCallback, useEffect, useState } from "react";
import { EmptyState } from "@/components/States";
import { apiFetch } from "@/lib/api";
import { apiErrorMessage } from "@/lib/apiErrors";
import { useAdminGate } from "@/lib/useAdminGate";
import { useLang, useT } from "@/lib/useLang";
import styles from "../approvals/approvals.module.css";

// VIA phase 3 - Users Management: every account, searchable by name or
// phone digits (always shown masked), filterable by type and status;
// each opens its detail page, where the platform actions are.

interface Row {
  id: string;
  display_name: string | null;
  phone_masked: string | null;
  platform_role: "PLATFORM_ADMIN" | "VERIFICATION_REVIEWER" | null;
  status: "ACTIVE" | "SUSPENDED" | "DEACTIVATED";
  store_roles: ("OWNER" | "BRANCH_EMPLOYEE")[];
  created_at: string;
}

const ROLES = [
  "customer",
  "store_owner",
  "store_employee",
  "PLATFORM_ADMIN",
  "VERIFICATION_REVIEWER",
] as const;
const STATES = ["ACTIVE", "SUSPENDED", "DEACTIVATED"] as const;
const EMPTY = { q: "", role: "all", status: "all" };
const danger = {
  background: "var(--color-danger-bg)",
  color: "var(--color-danger)",
};

export default function AdminUsersPage() {
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
      if (filters.role !== "all") qs.set("role", filters.role);
      if (filters.status !== "all") qs.set("status", filters.status);
      if (after) qs.set("cursor", after);
      return apiFetch<{ items: Row[]; next_cursor: string | null }>(
        `/admin/users?${qs}`,
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
          title={t("au.forbidden")}
          actionHref="/account"
          actionLabel={t("au.account")}
        />
      </div>
    );
  }

  const date = (iso: string) =>
    new Date(iso).toLocaleDateString(lang === "ar" ? "ar" : "en-GB", {
      dateStyle: "medium",
    });

  return (
    <div className="page-shell">
      <div className="wide-shell" style={{ maxWidth: 1100 }}>
        <div className="top-bar">
          <h1 className="page-title" style={{ margin: 0 }}>
            {t("au.title")}
          </h1>
        </div>
        <p className={styles.lead}>{t("au.lead")}</p>

        <form
          className={`${styles.panel} ${styles.filters}`}
          onSubmit={apply}
          style={{ marginBottom: 16 }}
        >
          <div className="field">
            <label htmlFor="au-q">{t("au.search")}</label>
            <input
              id="au-q"
              type="search"
              value={draft.q}
              placeholder={t("au.search_placeholder")}
              onChange={(e) => setDraft({ ...draft, q: e.target.value })}
            />
          </div>
          <div className="field">
            <label htmlFor="au-role">{t("au.f.role")}</label>
            <select
              id="au-role"
              value={draft.role}
              onChange={(e) => setDraft({ ...draft, role: e.target.value })}
            >
              <option value="all">{t("au.f.all")}</option>
              {ROLES.map((r) => (
                <option key={r} value={r}>
                  {t(`au.role.${r}`)}
                </option>
              ))}
            </select>
          </div>
          <div className="field">
            <label htmlFor="au-status">{t("au.f.status")}</label>
            <select
              id="au-status"
              value={draft.status}
              onChange={(e) => setDraft({ ...draft, status: e.target.value })}
            >
              <option value="all">{t("au.f.all")}</option>
              {STATES.map((s) => (
                <option key={s} value={s}>
                  {t(`au.status.${s}`)}
                </option>
              ))}
            </select>
          </div>
          <div
            style={{
              display: "flex",
              gap: 8,
              alignItems: "end",
              flexWrap: "wrap",
            }}
          >
            <button type="submit" className="button" data-testid="au-apply">
              {t("au.apply")}
            </button>
            <button
              type="button"
              className="button button-secondary"
              onClick={() => {
                setDraft(EMPTY);
                load(EMPTY);
              }}
            >
              {t("au.reset")}
            </button>
          </div>
        </form>

        {error !== null && (
          <div className={styles.unavailable} role="alert">
            <span>
              {t("au.load_failed")} {apiErrorMessage(error, lang)}
            </span>
            <button
              type="button"
              className="button"
              onClick={() => load(filters)}
            >
              {t("au.retry")}
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
          <p className={styles.empty}>{t("au.empty")}</p>
        )}
        {rows !== null && rows.length > 0 && (
          <ol className={styles.list} data-testid="au-list">
            <li className={styles.listHead} aria-hidden="true">
              <span>{t("au.col.user")}</span>
              <span>{t("au.col.roles")}</span>
              <span>{t("au.col.status")}</span>
              <span>{t("au.col.since")}</span>
              <span />
            </li>
            {rows.map((r) => (
              <li
                key={r.id}
                className={styles.row}
                data-testid="au-row"
                data-id={r.id}
              >
                <div className={styles.rowMain}>
                  <strong className={styles.rowPrimary}>
                    {r.display_name ?? t("au.no_name")}
                  </strong>
                  <span className={styles.rowSecondary}>
                    <bdi dir="ltr">{r.phone_masked}</bdi>
                  </span>
                </div>
                <span
                  className={styles.rowStatus}
                  style={{ display: "flex", flexWrap: "wrap", gap: 4 }}
                >
                  {r.platform_role && (
                    <span className="badge badge-active">
                      {t(`au.role.${r.platform_role}`)}
                    </span>
                  )}
                  {r.store_roles.map((s) => (
                    <span key={s} className="badge">
                      {t(`au.store_role.${s}`)}
                    </span>
                  ))}
                  {!r.platform_role && r.store_roles.length === 0 && (
                    <span className="badge">{t("au.role.customer")}</span>
                  )}
                </span>
                <span className={styles.rowStatus}>
                  <span
                    className="badge"
                    style={r.status === "ACTIVE" ? undefined : danger}
                    data-testid="au-row-status"
                  >
                    {t(`au.status.${r.status}`)}
                  </span>
                </span>
                <span className={styles.rowSecondary}>
                  {date(r.created_at)}
                </span>
                <Link href={`/admin/users/${r.id}`} className="button-link">
                  {t("au.open")}
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
              {t("au.load_more")}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
