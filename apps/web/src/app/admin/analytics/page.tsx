"use client";

import "@/lib/analyticsText";
import Link from "next/link";
import { FormEvent, useEffect, useState } from "react";
import {
  Bars,
  DailyChart,
  DataTable,
  ExportButtons,
  KpiCard,
  KpiGrid,
  useFormat,
} from "@/components/admin/AnalyticsWidgets";
import { EmptyState } from "@/components/States";
import { apiFetch } from "@/lib/api";
import { fill } from "@/lib/analyticsText";
import { apiErrorMessage } from "@/lib/apiErrors";
import { useAdminGate } from "@/lib/useAdminGate";
import { useT } from "@/lib/useLang";
import styles from "../approvals/approvals.module.css";

// VIA phase 4 - Analytics: one period filter (Asia/Hebron local days),
// one report (GET /admin/analytics/report), sections as tabs, each with
// CSV / Excel exports of the same figures. Sales Rank is the existing
// admin API; in-store POS is its own tab and never mixed in.

type Money = string;
type Overview = Record<string, number | Money>;
interface Report {
  meta: {
    from: string;
    to: string;
    days: number;
    time_zone: string;
    generated_at: string;
    previous: { from: string; to: string };
  };
  overview: Overview;
  change_pct: Record<string, number | null>;
  daily: {
    day: string;
    branch_orders: number;
    checkouts: number;
    completed_orders: number;
    gmv: Money;
    pos_sales: number;
    pos_total: Money;
  }[];
  status_breakdown: { status: string; count: number }[];
  returns_breakdown: { status: string; outcome: string; count: number }[];
  refunds_breakdown: {
    reason: string;
    kind: string;
    count: number;
    amount: Money;
  }[];
  stores: {
    store_id: string;
    store_name: string;
    branch_orders: number;
    completed_orders: number;
    gmv: Money;
    net_completed: Money;
    returns_opened: number;
    previous_gmv: Money;
    gmv_change_pct: number | null;
  }[];
  products: {
    offers: {
      offer_id: string;
      title_ar: string;
      title_en: string | null;
      store_name: string;
      units: number;
      gmv: Money;
    }[];
    canonical: {
      canonical_product_id: string;
      name_ar: string;
      name_en: string;
      stores: number;
      units: number;
      gmv: Money;
    }[];
  };
  customers: Record<string, number>;
  pos: {
    store_id: string;
    store_name: string;
    sales: number;
    total: Money;
    voided: number;
  }[];
}
interface SalesRank {
  entries: {
    scope: string;
    rank: number;
    qualified: boolean;
    units: number;
    customers: number;
    offer: { title: string; store: string } | null;
    canonical_product: { name: string } | null;
  }[];
}

const TABS = [
  "overview",
  "orders",
  "stores",
  "products",
  "customers",
  "sales_rank",
  "pos",
] as const;
type Tab = (typeof TABS)[number];

function todayLocal(): string {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone: "Asia/Hebron",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    })
      .formatToParts(new Date())
      .map((x) => [x.type, x.value]),
  );
  return `${p.year}-${p.month}-${p.day}`;
}
function minusDays(ymd: string, n: number): string {
  const [y, m, d] = ymd.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d - n)).toISOString().slice(0, 10);
}

export default function AdminAnalyticsPage() {
  const gate = useAdminGate("ADMIN");
  const t = useT();
  const f = useFormat();
  const today = todayLocal();
  const [draft, setDraft] = useState({ from: minusDays(today, 29), to: today });
  const [period, setPeriod] = useState(draft);
  const [tab, setTab] = useState<Tab>("overview");
  const [report, setReport] = useState<Report | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [rank, setRank] = useState<SalesRank | null | "error">(null);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    if (gate.status !== "ok") return;
    let cancelled = false;
    apiFetch<Report>(`/admin/analytics/report?${new URLSearchParams(period)}`)
      .then((r) => !cancelled && setReport(r))
      .catch((e) => !cancelled && setError(e));
    return () => {
      cancelled = true;
    };
  }, [gate.status, period, attempt]);

  useEffect(() => {
    if (gate.status !== "ok" || tab !== "sales_rank" || rank !== null) return;
    apiFetch<SalesRank>("/admin/sales-rank?take=50")
      .then(setRank)
      .catch(() => setRank("error"));
  }, [gate.status, tab, rank]);

  function load(next: { from: string; to: string }) {
    setReport(null);
    setError(null);
    setPeriod(next);
    setAttempt((a) => a + 1);
  }
  function apply(e: FormEvent) {
    e.preventDefault();
    load({ ...draft });
  }
  function preset(days: number) {
    const next = { from: minusDays(today, days - 1), to: today };
    setDraft(next);
    load(next);
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
          title={t("an.forbidden")}
          actionHref="/account"
          actionLabel={t("an.account")}
        />
      </div>
    );
  }

  const r = report;
  const o = r?.overview;
  const ch = r?.change_pct ?? {};
  const kpi = (k: string, kind: "money" | "num", help?: string) =>
    o ? (
      <KpiCard
        key={k}
        testId={`an-kpi-${k}`}
        label={t(`an.k.${k}`)}
        value={kind === "money" ? f.money(String(o[k])) : f.num(Number(o[k]))}
        change={ch[k] ?? null}
        help={help}
      />
    ) : null;
  const exports = (section: string) =>
    r ? (
      <ExportButtons section={section} from={r.meta.from} to={r.meta.to} />
    ) : null;
  const head = (title: string, section?: string) => (
    <div
      style={{
        display: "flex",
        justifyContent: "space-between",
        alignItems: "center",
        gap: 8,
        flexWrap: "wrap",
        marginBottom: 10,
      }}
    >
      <h2 className={styles.panelTitle} style={{ margin: 0 }}>
        {title}
      </h2>
      {section && exports(section)}
    </div>
  );
  const title = (x: { title_ar: string; title_en: string | null }) =>
    f.lang === "en" && x.title_en ? x.title_en : x.title_ar;

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
        <div className="top-bar">
          <h1 className="page-title" style={{ margin: 0 }}>
            {t("an.analytics")}
          </h1>
        </div>
        <p className={styles.lead} style={{ margin: 0 }}>
          {t("an.analytics_lead")}
        </p>

        <form className={`${styles.panel} ${styles.filters}`} onSubmit={apply}>
          <div className="field">
            <label htmlFor="an-from">{t("an.f.from")}</label>
            <input
              id="an-from"
              type="date"
              value={draft.from}
              max={draft.to}
              onChange={(e) => setDraft({ ...draft, from: e.target.value })}
            />
          </div>
          <div className="field">
            <label htmlFor="an-to">{t("an.f.to")}</label>
            <input
              id="an-to"
              type="date"
              value={draft.to}
              min={draft.from}
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
            <button type="submit" className="button" data-testid="an-apply">
              {t("an.f.apply")}
            </button>
            {[7, 30, 90].map((d) => (
              <button
                key={d}
                type="button"
                className="button button-secondary"
                onClick={() => preset(d)}
              >
                {t(`an.f.last${d}`)}
              </button>
            ))}
          </div>
        </form>

        <div
          role="tablist"
          style={{ display: "flex", flexWrap: "wrap", gap: 6 }}
        >
          {TABS.map((x) => (
            <button
              key={x}
              type="button"
              role="tab"
              aria-selected={tab === x}
              className={tab === x ? "button" : "button button-secondary"}
              onClick={() => setTab(x)}
              data-testid={`an-tab-${x}`}
            >
              {t(`an.tab.${x}`)}
            </button>
          ))}
        </div>

        {error !== null && (
          <div className={styles.unavailable} role="alert">
            <span>
              {t("an.load_failed")} {apiErrorMessage(error, f.lang)}
            </span>
            <button
              type="button"
              className="button"
              onClick={() => load(period)}
            >
              {t("an.retry")}
            </button>
          </div>
        )}
        {!r && error === null && (
          <div
            className="skeleton"
            aria-busy="true"
            style={{ height: 320, width: "100%" }}
          />
        )}

        {r && o && (
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
                from: r.meta.from,
                to: r.meta.to,
                days: r.meta.days,
                tz: r.meta.time_zone,
              })}{" "}
              ·{" "}
              {fill(t("an.vs_prev"), {
                from: r.meta.previous.from,
                to: r.meta.previous.to,
              })}{" "}
              · {fill(t("an.as_of"), { at: f.time(r.meta.generated_at) })}
            </p>

            {tab === "overview" && (
              <>
                <section className={styles.panel}>
                  {head(t("an.tab.overview"), "overview")}
                  <KpiGrid>
                    {kpi("gmv", "money", t("an.help.gmv"))}
                    {kpi("net_completed", "money", t("an.help.net_completed"))}
                    {kpi("branch_orders", "num")}
                    {kpi("checkouts", "num")}
                    {kpi("completed_orders", "num")}
                    {kpi("buyers", "num")}
                    {kpi("registrations", "num")}
                    {kpi("returns_opened", "num", t("an.help.returns_opened"))}
                  </KpiGrid>
                  <p
                    style={{
                      margin: "10px 0 0",
                      fontSize: 12.5,
                      color: "var(--color-text-muted)",
                    }}
                  >
                    {t("an.revenue_unavailable")}
                  </p>
                </section>
                <section className={styles.panel}>
                  {head(t("an.sec.trend"), "daily")}
                  <DailyChart rows={r.daily} />
                </section>
              </>
            )}

            {tab === "orders" && (
              <>
                <section className={styles.panel}>
                  {head(t("an.sec.money"), "overview")}
                  <KpiGrid>
                    {kpi("gmv", "money", t("an.help.gmv"))}
                    {kpi("later_merchandise_refunds", "money")}
                    {kpi("net_completed", "money", t("an.help.net_completed"))}
                    {kpi(
                      "merchandise_refunds",
                      "money",
                      t("an.help.merchandise_refunds"),
                    )}
                    {kpi("delivery_fee_refunds", "money")}
                    {kpi("completed_units", "num")}
                    {kpi("cancelled_lines", "num")}
                    {kpi("cancelled_value", "money")}
                    {kpi("cancelled_orders", "num")}
                    {kpi("returns_opened", "num", t("an.help.returns_opened"))}
                  </KpiGrid>
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
                    {head(t("an.statuses_title"))}
                    {r.status_breakdown.length === 0 ? (
                      <p className={styles.empty}>{t("an.no_data")}</p>
                    ) : (
                      <Bars
                        testId="an-status-bars"
                        rows={r.status_breakdown.map((s) => ({
                          label: t(`ao.status.${s.status}`),
                          value: s.count,
                        }))}
                      />
                    )}
                  </section>
                  <section className={styles.panel}>
                    {head(t("an.refunds_title"), "refunds")}
                    <DataTable
                      testId="an-refunds"
                      columns={[
                        t("an.c.reason"),
                        t("an.c.kind"),
                        t("an.c.count"),
                        t("an.c.amount"),
                      ]}
                      rows={r.refunds_breakdown.map((x) => [
                        t(`ao.refund.${x.reason}`),
                        t(`an.kind.${x.kind}`),
                        f.num(x.count),
                        <bdi key="a">{f.money(x.amount)}</bdi>,
                      ])}
                    />
                  </section>
                </div>
                <section className={styles.panel}>
                  {head(t("an.returns_title"), "returns")}
                  <DataTable
                    testId="an-returns"
                    columns={[
                      t("an.c.status"),
                      t("an.c.outcome"),
                      t("an.c.count"),
                    ]}
                    rows={r.returns_breakdown.map((x) => [
                      t(`ret.status.${x.status}`),
                      t(`ao.d.outcome.${x.outcome}`),
                      f.num(x.count),
                    ])}
                  />
                </section>
              </>
            )}

            {tab === "stores" && (
              <section className={styles.panel}>
                {head(t("an.tab.stores"), "stores")}
                <DataTable
                  testId="an-stores"
                  columns={[
                    t("an.c.store"),
                    t("an.c.orders"),
                    t("an.c.completed"),
                    t("an.c.gmv"),
                    t("an.c.net"),
                    t("an.c.returns"),
                    t("an.c.prev_gmv"),
                    t("an.c.change"),
                  ]}
                  rows={r.stores.map((s) => [
                    <Link key="s" href={`/admin/vendors/${s.store_id}`}>
                      {s.store_name}
                    </Link>,
                    f.num(s.branch_orders),
                    f.num(s.completed_orders),
                    <bdi key="g">{f.money(s.gmv)}</bdi>,
                    <bdi key="n">{f.money(s.net_completed)}</bdi>,
                    f.num(s.returns_opened),
                    <bdi key="p">{f.money(s.previous_gmv)}</bdi>,
                    <bdi key="c">
                      {f.pct(s.gmv_change_pct) ?? t("an.no_compare")}
                    </bdi>,
                  ])}
                />
                <p
                  style={{
                    margin: "10px 0 0",
                    fontSize: 12.5,
                    color: "var(--color-text-muted)",
                  }}
                >
                  {fill(t("an.top_limit"), { n: 50 })} ·{" "}
                  <Link
                    href="/admin/vendors/performance"
                    className="button-link"
                  >
                    {t("an.perf_link")}
                  </Link>
                </p>
              </section>
            )}

            {tab === "products" && (
              <>
                <section className={styles.panel}>
                  {head(t("an.offers_title"), "products")}
                  <DataTable
                    testId="an-offers"
                    columns={[
                      t("an.c.offer"),
                      t("an.c.store"),
                      t("an.c.units"),
                      t("an.c.gmv"),
                    ]}
                    rows={r.products.offers.map((x) => [
                      title(x),
                      x.store_name,
                      f.num(x.units),
                      <bdi key="g">{f.money(x.gmv)}</bdi>,
                    ])}
                  />
                </section>
                <section className={styles.panel}>
                  {head(t("an.canonical_title"), "canonical")}
                  <DataTable
                    testId="an-canonical"
                    columns={[
                      t("an.c.canonical"),
                      t("an.c.stores"),
                      t("an.c.units"),
                      t("an.c.gmv"),
                    ]}
                    rows={r.products.canonical.map((x) => [
                      f.lang === "en" ? x.name_en : x.name_ar,
                      f.num(x.stores),
                      f.num(x.units),
                      <bdi key="g">{f.money(x.gmv)}</bdi>,
                    ])}
                  />
                </section>
              </>
            )}

            {tab === "customers" && (
              <section className={styles.panel}>
                {head(t("an.tab.customers"), "customers")}
                <KpiGrid>
                  {(
                    [
                      "registrations",
                      "buyers",
                      "new_buyers",
                      "returning_buyers",
                      "repeat_buyers_in_period",
                    ] as const
                  ).map((k) => (
                    <KpiCard
                      key={k}
                      testId={`an-cust-${k}`}
                      label={t(`an.k.${k}`)}
                      value={f.num(r.customers[k] ?? 0)}
                      help={
                        k === "returning_buyers"
                          ? t("an.help.returning_buyers")
                          : undefined
                      }
                    />
                  ))}
                  <KpiCard
                    label={t("an.k.checkouts")}
                    value={f.num(r.customers.checkouts ?? 0)}
                  />
                </KpiGrid>
              </section>
            )}

            {tab === "sales_rank" && (
              <section className={styles.panel}>
                {head(t("an.tab.sales_rank"))}
                <p className={styles.lead} style={{ marginTop: 0 }}>
                  {t("an.sales_rank_lead")}
                </p>
                {rank === null && (
                  <div
                    className="skeleton"
                    style={{ height: 120, width: "100%" }}
                  />
                )}
                {rank === "error" && (
                  <p className={styles.empty}>
                    {t("an.sales_rank_unavailable")}
                  </p>
                )}
                {rank && rank !== "error" && (
                  <DataTable
                    testId="an-sales-rank"
                    columns={[
                      t("an.sr.rank"),
                      t("an.sr.name"),
                      t("an.c.store"),
                      t("an.c.units"),
                      t("an.sr.qualified"),
                    ]}
                    rows={rank.entries.map((e) => [
                      `${e.scope} #${e.rank}`,
                      e.offer?.title ?? e.canonical_product?.name ?? "-",
                      e.offer?.store ?? "-",
                      f.num(e.units),
                      e.qualified ? "✓" : "-",
                    ])}
                  />
                )}
              </section>
            )}

            {tab === "pos" && (
              <>
                <section className={styles.panel}>
                  {head(t("an.tab.pos"), "pos")}
                  <p className={styles.lead} style={{ marginTop: 0 }}>
                    {t("an.help.pos")}
                  </p>
                  <KpiGrid>
                    {kpi("pos_sales", "num")}
                    {kpi("pos_total", "money")}
                  </KpiGrid>
                  <div style={{ marginTop: 12 }}>
                    <DataTable
                      testId="an-pos"
                      columns={[
                        t("an.c.store"),
                        t("an.c.sales"),
                        t("an.c.total"),
                        t("an.c.voided"),
                      ]}
                      rows={r.pos.map((p) => [
                        p.store_name,
                        f.num(p.sales),
                        <bdi key="t">{f.money(p.total)}</bdi>,
                        f.num(p.voided),
                      ])}
                    />
                  </div>
                </section>
              </>
            )}
          </>
        )}
      </div>
    </div>
  );
}
