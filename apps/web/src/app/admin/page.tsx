"use client";

import "@/lib/analyticsText";
import "@/lib/approvalCenterText";
import "@/lib/adminNavText";
import "@/lib/workspaceText";
import Link from "next/link";
import { useEffect, useState } from "react";
import {
  Bars,
  DailyChart,
  KpiCard,
  KpiGrid,
  useFormat,
} from "@/components/admin/AnalyticsWidgets";
import { EmptyState } from "@/components/States";
import { apiFetch } from "@/lib/api";
import { fill } from "@/lib/analyticsText";
import { ADMIN_DESC_KEY_PREFIX } from "@/lib/adminNavText";
import { apiErrorMessage } from "@/lib/apiErrors";
import { auditText } from "@/lib/auditActionText";
import { adminTiles } from "@/lib/nav";
import { useAdminGate } from "@/lib/useAdminGate";
import { useT } from "@/lib/useLang";
import styles from "./approvals/approvals.module.css";

// VIA phase 4: the platform dashboard - real figures only (GET
// /admin/analytics/dashboard), the Approval Center's own actor-authorized
// counts, the last 30 local days against the 30 before, recent admin
// activity, and the existing workflows as shortcuts. A verification
// reviewer keeps the plain hub (the API refuses them the figures anyway).

type Money = string;
interface Overview {
  branch_orders: number;
  checkouts: number;
  completed_orders: number;
  gmv: Money;
  net_completed: Money;
  merchandise_refunds: Money;
  delivery_fee_refunds: Money;
  returns_opened: number;
  cancelled_lines: number;
  buyers: number;
  registrations: number;
  pos_sales: number;
  pos_total: Money;
}
interface Dashboard {
  meta: {
    from: string;
    to: string;
    days: number;
    time_zone: string;
    generated_at: string;
  };
  stores: { registered: number; active: number; published: number };
  accounts: {
    enabled_customers: number;
    enabled_store_owners: number;
    enabled_distinct: number;
  };
  catalog: { public_offers: number; published_canonical_products: number };
  orders_by_status: { status: string; count: number }[];
  orders_total: number;
  open_returns: number;
  last_30_days: Overview;
  change_pct: Record<string, number | null>;
  daily: { day: string; branch_orders: number; gmv: string }[];
  recent_admin_activity: {
    id: string;
    action: string;
    entity_type: string;
    at: string;
  }[];
}
interface Approvals {
  total: number;
  partial: boolean;
  sources: { source: string; status: string; pending: number | null }[];
}

export default function AdminHubPage() {
  // reportErrors: a failed workspaces read (5xx, network) is an error with
  // a retry, never "forbidden"; only a missing platform role is forbidden.
  const gate = useAdminGate("ANY", { reportErrors: true });
  const t = useT();
  const f = useFormat();
  const isAdmin = gate.status === "ok" && gate.role === "PLATFORM_ADMIN";
  const [data, setData] = useState<Dashboard | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [approvals, setApprovals] = useState<Approvals | null>(null);
  const [approvalsError, setApprovalsError] = useState<unknown>(null);
  const [attempt, setAttempt] = useState(0);
  const [approvalsAttempt, setApprovalsAttempt] = useState(0);

  useEffect(() => {
    if (!isAdmin) return;
    let cancelled = false;
    apiFetch<Dashboard>("/admin/analytics/dashboard")
      .then((d) => !cancelled && setData(d))
      .catch((e) => !cancelled && setError(e));
    return () => {
      cancelled = true;
    };
  }, [isAdmin, attempt]);

  useEffect(() => {
    if (!isAdmin) return;
    let cancelled = false;
    apiFetch<Approvals>("/admin/approval-center/summary")
      .then((a) => !cancelled && setApprovals(a))
      .catch((e) => !cancelled && setApprovalsError(e));
    return () => {
      cancelled = true;
    };
  }, [isAdmin, approvalsAttempt]);

  if (gate.status === "loading") {
    return (
      <div className="page-shell">
        <div
          className="skeleton"
          style={{ height: 120, width: "100%", maxWidth: 1100 }}
        />
      </div>
    );
  }
  if (gate.status === "error") {
    return (
      <div className="page-shell">
        <div
          className={styles.unavailable}
          role="alert"
          data-testid="an-gate-error"
          style={{ maxWidth: 700, margin: "24px auto 0" }}
        >
          <span>
            {t("an.gate_failed")} {apiErrorMessage(gate.error, f.lang)}
          </span>
          <button
            type="button"
            className="button"
            onClick={() => window.location.reload()}
          >
            {t("an.retry")}
          </button>
        </div>
      </div>
    );
  }
  if (gate.status === "forbidden") {
    return (
      <div className="page-shell">
        <EmptyState
          title={t("an.hub_forbidden")}
          actionHref="/account"
          actionLabel={t("an.my_account")}
        />
      </div>
    );
  }

  // English descriptions come from lib/adminNavText.ts; Arabic (or a
  // route without an English entry) keeps the tile's own description.
  const describe = (tile: { href: string; description: string }) => {
    const key = `${ADMIN_DESC_KEY_PREFIX}${tile.href}`;
    const text = f.lang === "en" ? t(key) : key;
    return text === key ? tile.description : text;
  };

  const tiles = (
    <div className="hub-grid">
      {adminTiles(gate.role).map((tile) => (
        <Link key={tile.href} href={tile.href} className="hub-tile">
          <strong>{t(`admin.nav.${tile.href}`) || tile.title}</strong>
          <span>{describe(tile)}</span>
        </Link>
      ))}
    </div>
  );

  if (!isAdmin) {
    return (
      <div className="page-shell">
        <div className="wide-shell" style={{ maxWidth: 1000 }}>
          <div className="top-bar">
            <div>
              <h1 className="page-title" style={{ margin: 0 }}>
                {t("admin.frame.title")}
              </h1>
              <span className="badge badge-active">
                {t(`ws.enter.role.${gate.role}`)}
              </span>
            </div>
          </div>
          {tiles}
        </div>
      </div>
    );
  }

  const o = data?.last_30_days;
  const ch = data?.change_pct ?? {};

  return (
    <div className="page-shell">
      <div
        className="wide-shell"
        style={{
          maxWidth: 1100,
          display: "grid",
          gridTemplateColumns: "minmax(0, 1fr)",
          gap: 16,
        }}
      >
        <div className="top-bar" style={{ flexWrap: "wrap", gap: 8 }}>
          <h1 className="page-title" style={{ margin: 0 }}>
            {t("an.dashboard")}
          </h1>
          <Link
            href="/admin/analytics"
            className="button button-secondary"
            data-testid="an-open-analytics"
          >
            {t("an.open_analytics")}
          </Link>
        </div>
        <p className={styles.lead} style={{ margin: 0 }}>
          {t("an.dashboard_lead")}
        </p>

        {error !== null && (
          <div className={styles.unavailable} role="alert">
            <span>
              {t("an.load_failed")} {apiErrorMessage(error, f.lang)}
            </span>
            <button
              type="button"
              className="button"
              onClick={() => {
                setError(null);
                setAttempt((a) => a + 1);
              }}
            >
              {t("an.retry")}
            </button>
          </div>
        )}
        {!data && error === null && (
          <div
            className="skeleton"
            aria-busy="true"
            style={{ height: 320, width: "100%" }}
          />
        )}

        {data && o && (
          <>
            <p
              style={{
                margin: 0,
                fontSize: 12.5,
                color: "var(--color-text-muted)",
              }}
              data-testid="an-period"
            >
              {fill(t("an.period"), {
                from: data.meta.from,
                to: data.meta.to,
                days: data.meta.days,
                tz: data.meta.time_zone,
              })}{" "}
              · {fill(t("an.as_of"), { at: f.time(data.meta.generated_at) })}
            </p>

            <section className={styles.panel}>
              <h2 className={styles.panelTitle}>{t("an.sec.money")}</h2>
              <KpiGrid>
                <KpiCard
                  testId="an-kpi-gmv"
                  label={t("an.k.gmv")}
                  value={f.money(o.gmv)}
                  change={ch.gmv}
                  help={t("an.help.gmv")}
                />
                <KpiCard
                  label={t("an.k.net_completed")}
                  value={f.money(o.net_completed)}
                  change={ch.net_completed}
                  help={t("an.help.net_completed")}
                />
                <KpiCard
                  label={t("an.k.merchandise_refunds")}
                  value={f.money(o.merchandise_refunds)}
                  change={ch.merchandise_refunds}
                />
                <KpiCard
                  label={t("an.k.delivery_fee_refunds")}
                  value={f.money(o.delivery_fee_refunds)}
                  change={ch.delivery_fee_refunds}
                />
                <KpiCard
                  label={t("an.k.branch_orders")}
                  value={f.num(o.branch_orders)}
                  change={ch.branch_orders}
                />
                <KpiCard
                  label={t("an.k.completed_orders")}
                  value={f.num(o.completed_orders)}
                  change={ch.completed_orders}
                />
                <KpiCard
                  label={t("an.k.returns_opened")}
                  value={f.num(o.returns_opened)}
                  change={ch.returns_opened}
                  help={t("an.help.returns_opened")}
                />
                <KpiCard
                  label={t("an.k.cancelled_lines")}
                  value={f.num(o.cancelled_lines)}
                  change={ch.cancelled_lines}
                />
              </KpiGrid>
              <p
                style={{
                  margin: "10px 0 0",
                  fontSize: 12.5,
                  color: "var(--color-text-muted)",
                }}
                data-testid="an-revenue-note"
              >
                {t("an.revenue_unavailable")}
              </p>
            </section>

            <div
              style={{
                display: "grid",
                gap: 16,
                gridTemplateColumns:
                  "repeat(auto-fit, minmax(min(100%, 330px), 1fr))",
              }}
            >
              <section className={styles.panel}>
                <h2 className={styles.panelTitle}>{t("an.sec.stores")}</h2>
                <KpiGrid>
                  <KpiCard
                    testId="an-kpi-registered"
                    label={t("an.k.registered")}
                    value={f.num(data.stores.registered)}
                  />
                  <KpiCard
                    label={t("an.k.active")}
                    value={f.num(data.stores.active)}
                  />
                  <KpiCard
                    label={t("an.k.published")}
                    value={f.num(data.stores.published)}
                  />
                </KpiGrid>
              </section>
              <section className={styles.panel}>
                <h2 className={styles.panelTitle}>{t("an.sec.accounts")}</h2>
                <KpiGrid>
                  <KpiCard
                    label={t("an.k.enabled_customers")}
                    value={f.num(data.accounts.enabled_customers)}
                  />
                  <KpiCard
                    label={t("an.k.enabled_store_owners")}
                    value={f.num(data.accounts.enabled_store_owners)}
                  />
                  <KpiCard
                    label={t("an.k.enabled_distinct")}
                    value={f.num(data.accounts.enabled_distinct)}
                  />
                </KpiGrid>
              </section>
              <section className={styles.panel}>
                <h2 className={styles.panelTitle}>{t("an.sec.catalog")}</h2>
                <KpiGrid>
                  <KpiCard
                    label={t("an.k.public_offers")}
                    value={f.num(data.catalog.public_offers)}
                  />
                  <KpiCard
                    label={t("an.k.published_canonical_products")}
                    value={f.num(data.catalog.published_canonical_products)}
                  />
                </KpiGrid>
              </section>
            </div>

            <section className={styles.panel}>
              <h2 className={styles.panelTitle}>{t("an.sec.trend")}</h2>
              <DailyChart rows={data.daily} />
            </section>

            <div
              style={{
                display: "grid",
                gap: 16,
                gridTemplateColumns:
                  "repeat(auto-fit, minmax(min(100%, 330px), 1fr))",
              }}
            >
              <section className={styles.panel}>
                <h2 className={styles.panelTitle}>
                  {t("an.sec.orders_status")}
                </h2>
                <KpiGrid>
                  <KpiCard
                    label={t("an.k.orders_total")}
                    value={f.num(data.orders_total)}
                  />
                  <KpiCard
                    label={t("an.k.open_returns")}
                    value={f.num(data.open_returns)}
                  />
                </KpiGrid>
                <div style={{ marginTop: 12 }}>
                  {data.orders_by_status.length === 0 ? (
                    <p className={styles.empty}>{t("an.no_data")}</p>
                  ) : (
                    <Bars
                      testId="an-status-bars"
                      rows={data.orders_by_status.map((s) => ({
                        label: t(`ao.status.${s.status}`),
                        value: s.count,
                      }))}
                    />
                  )}
                </div>
                <p style={{ margin: "10px 0 0" }}>
                  <Link href="/admin/orders" className="button-link">
                    {t("admin.nav./admin/orders")}
                  </Link>
                </p>
              </section>

              <section className={styles.panel} data-testid="an-approvals">
                <h2 className={styles.panelTitle}>{t("an.sec.approvals")}</h2>
                {approvalsError !== null ? (
                  <div
                    className={styles.unavailable}
                    role="alert"
                    data-testid="an-approvals-error"
                  >
                    <span>
                      {t("an.approvals_failed")}{" "}
                      {apiErrorMessage(approvalsError, f.lang)}
                    </span>
                    <button
                      type="button"
                      className="button"
                      onClick={() => {
                        setApprovalsError(null);
                        setApprovalsAttempt((a) => a + 1);
                      }}
                    >
                      {t("an.retry")}
                    </button>
                  </div>
                ) : !approvals ? (
                  <div
                    className="skeleton"
                    style={{ height: 80, width: "100%" }}
                  />
                ) : (
                  <>
                    <p style={{ margin: "0 0 8px", fontWeight: 700 }}>
                      {fill(t("an.approvals_total"), { n: approvals.total })}
                    </p>
                    <Bars
                      rows={approvals.sources
                        .filter((s) => s.status === "AVAILABLE")
                        .map((s) => ({
                          label: t(`ac.source.${s.source}`),
                          value: s.pending ?? 0,
                        }))}
                    />
                    {approvals.partial && (
                      <p className={styles.empty}>
                        {t("an.approvals_partial")}
                      </p>
                    )}
                    <p style={{ margin: "10px 0 0" }}>
                      <Link href="/admin/approvals" className="button-link">
                        {t("an.approvals_open")}
                      </Link>
                    </p>
                  </>
                )}
              </section>
            </div>

            <section className={styles.panel}>
              <h2 className={styles.panelTitle}>{t("an.sec.activity")}</h2>
              {data.recent_admin_activity.length === 0 ? (
                <p className={styles.empty}>{t("an.no_data")}</p>
              ) : (
                <ol className={styles.list} data-testid="an-activity">
                  {data.recent_admin_activity.map((a) => (
                    <li
                      key={a.id}
                      className={styles.row}
                      style={{ gridTemplateColumns: "minmax(0,1fr) auto" }}
                    >
                      <div className={styles.rowMain}>
                        {/* The readable name; the raw code stays in the
                            Audit Log and in the tooltip. An unnamed code
                            shows as itself. */}
                        <strong
                          className={styles.rowPrimary}
                          title={a.action}
                          data-action={a.action}
                        >
                          {auditText(t, "action", a.action) ?? (
                            <bdi dir="ltr">{a.action}</bdi>
                          )}
                        </strong>
                        <span className={styles.rowSecondary}>
                          {auditText(t, "entity", a.entity_type) ??
                            a.entity_type}
                        </span>
                      </div>
                      <span className={styles.rowSecondary}>
                        {f.time(a.at)}
                      </span>
                    </li>
                  ))}
                </ol>
              )}
              <p style={{ margin: "10px 0 0" }}>
                <Link href="/admin/audit-logs" className="button-link">
                  {t("admin.nav./admin/audit-logs")}
                </Link>
              </p>
            </section>
          </>
        )}

        <section>
          <h2 className={styles.panelTitle}>{t("an.sec.shortcuts")}</h2>
          {tiles}
        </section>
      </div>
    </div>
  );
}
