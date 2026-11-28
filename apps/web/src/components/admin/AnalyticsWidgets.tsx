"use client";

import "@/lib/analyticsText";
import { useState, type ReactNode } from "react";
import { authHeadersFor } from "@/lib/api";
import { useLang, useT } from "@/lib/useLang";

// VIA phase 4 - small, dependency-free widgets for the dashboard and the
// analytics page: KPI cards with the previous-period change, a daily bar
// chart (SVG), horizontal status bars, a plain table and the export
// buttons. Numbers arrive from the API as decimal strings (ILS) or counts.

const API_BASE_URL =
  process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3001/api/v1";

export function useFormat() {
  const lang = useLang();
  const locale = lang === "ar" ? "ar" : "en-GB";
  return {
    lang,
    num: (n: number) => n.toLocaleString(locale),
    money: (v: string | number | null) =>
      v === null || v === undefined
        ? "-"
        : `${Number(v).toLocaleString(locale, { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ₪`,
    pct: (v: number | null) =>
      v === null ? null : `${v > 0 ? "+" : ""}${v.toLocaleString(locale)}%`,
    time: (iso: string) =>
      new Date(iso).toLocaleString(locale, {
        dateStyle: "medium",
        timeStyle: "short",
      }),
  };
}

export function KpiCard({
  label,
  value,
  change,
  help,
  testId,
}: {
  label: string;
  value: string;
  change?: number | null;
  help?: string;
  testId?: string;
}) {
  const t = useT();
  const f = useFormat();
  const c = change === undefined ? undefined : f.pct(change);
  return (
    <div
      data-testid={testId}
      style={{
        border: "1px solid var(--color-border)",
        borderRadius: 14,
        padding: "12px 14px",
        background: "#fffdf9",
        display: "grid",
        gap: 4,
        minWidth: 0,
      }}
      title={help}
    >
      <span
        style={{
          fontSize: 12.5,
          fontWeight: 700,
          color: "var(--color-text-muted)",
        }}
      >
        {label}
      </span>
      <strong
        style={{ fontSize: 20, lineHeight: 1.2, overflowWrap: "anywhere" }}
      >
        <bdi>{value}</bdi>
      </strong>
      {c !== undefined && (
        <span
          style={{
            fontSize: 12,
            color:
              change === null || change === undefined
                ? "var(--color-text-muted)"
                : change >= 0
                  ? "var(--color-success, #2f7d4f)"
                  : "var(--color-danger)",
          }}
        >
          <bdi>{c ?? t("an.no_compare")}</bdi>
        </span>
      )}
      {help && (
        <span style={{ fontSize: 11.5, color: "var(--color-text-muted)" }}>
          {help}
        </span>
      )}
    </div>
  );
}

export function KpiGrid({ children }: { children: ReactNode }) {
  return (
    <div
      style={{
        display: "grid",
        gap: 10,
        gridTemplateColumns: "repeat(auto-fill, minmax(min(100%, 170px), 1fr))",
      }}
    >
      {children}
    </div>
  );
}

/** Daily bars (orders) with a GMV line; reads left-to-right in time in both languages. */
export function DailyChart({
  rows,
}: {
  rows: { day: string; branch_orders: number; gmv: string }[];
}) {
  const t = useT();
  const f = useFormat();
  if (rows.length === 0) return null;
  const W = Math.max(rows.length * 18, 300);
  const H = 160;
  const pad = 22;
  const maxOrders = Math.max(1, ...rows.map((r) => r.branch_orders));
  const maxGmv = Math.max(1, ...rows.map((r) => Number(r.gmv)));
  const bw = (W - pad * 2) / rows.length;
  const y = (v: number, max: number) => H - pad - (v / max) * (H - pad * 2);
  const line = rows
    .map((r, i) => `${pad + bw * i + bw / 2},${y(Number(r.gmv), maxGmv)}`)
    .join(" ");
  return (
    <figure style={{ margin: 0 }} data-testid="an-daily-chart">
      <div style={{ overflowX: "auto" }} dir="ltr">
        <svg
          viewBox={`0 0 ${W} ${H}`}
          width="100%"
          height={H}
          role="img"
          aria-label={t("an.sec.trend")}
          preserveAspectRatio="none"
        >
          <line
            x1={pad}
            x2={W - pad}
            y1={H - pad}
            y2={H - pad}
            stroke="var(--color-border)"
          />
          {rows.map((r, i) => (
            <rect
              key={r.day}
              x={pad + bw * i + bw * 0.15}
              width={bw * 0.7}
              y={y(r.branch_orders, maxOrders)}
              height={H - pad - y(r.branch_orders, maxOrders)}
              fill="var(--color-primary, #6b2d3c)"
              opacity={0.75}
            >
              <title>{`${r.day}: ${r.branch_orders} · ${f.money(r.gmv)}`}</title>
            </rect>
          ))}
          <polyline
            points={line}
            fill="none"
            stroke="var(--color-accent, #b08d3c)"
            strokeWidth={2}
          />
          <text x={pad} y={H - 6} fontSize={10} fill="currentColor">
            {rows[0].day}
          </text>
          <text
            x={W - pad}
            y={H - 6}
            fontSize={10}
            fill="currentColor"
            textAnchor="end"
          >
            {rows[rows.length - 1].day}
          </text>
        </svg>
      </div>
      <figcaption
        style={{
          display: "flex",
          gap: 14,
          fontSize: 12,
          color: "var(--color-text-muted)",
          flexWrap: "wrap",
        }}
      >
        <span>
          <span
            style={{
              display: "inline-block",
              width: 10,
              height: 10,
              background: "var(--color-primary, #6b2d3c)",
              opacity: 0.75,
              marginInlineEnd: 4,
            }}
          />
          {t("an.legend.orders")} ({f.num(maxOrders)} max)
        </span>
        <span>
          <span
            style={{
              display: "inline-block",
              width: 12,
              height: 2,
              background: "var(--color-accent, #b08d3c)",
              verticalAlign: "middle",
              marginInlineEnd: 4,
            }}
          />
          {t("an.legend.gmv")} ({f.money(maxGmv)} max)
        </span>
      </figcaption>
    </figure>
  );
}

export function Bars({
  rows,
  testId,
}: {
  rows: { label: string; value: number }[];
  testId?: string;
}) {
  const f = useFormat();
  const max = Math.max(1, ...rows.map((r) => r.value));
  return (
    <ul
      style={{
        listStyle: "none",
        margin: 0,
        padding: 0,
        display: "grid",
        gap: 6,
      }}
      data-testid={testId}
    >
      {rows.map((r) => (
        <li
          key={r.label}
          style={{
            display: "grid",
            gridTemplateColumns: "minmax(90px, 32%) 1fr auto",
            gap: 8,
            alignItems: "center",
            fontSize: 13,
          }}
        >
          <span
            style={{
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
          >
            {r.label}
          </span>
          <span
            style={{
              background: "var(--color-border)",
              borderRadius: 4,
              height: 10,
              overflow: "hidden",
            }}
          >
            <span
              style={{
                display: "block",
                height: "100%",
                width: `${(r.value / max) * 100}%`,
                background: "var(--color-primary, #6b2d3c)",
              }}
            />
          </span>
          <strong>{f.num(r.value)}</strong>
        </li>
      ))}
    </ul>
  );
}

export function DataTable({
  columns,
  rows,
  testId,
}: {
  columns: string[];
  rows: ReactNode[][];
  testId?: string;
}) {
  const t = useT();
  if (rows.length === 0)
    return (
      <p style={{ color: "var(--color-text-muted)", margin: 0 }}>
        {t("an.no_data")}
      </p>
    );
  return (
    <div style={{ overflowX: "auto" }}>
      <table
        data-testid={testId}
        style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}
      >
        <thead>
          <tr>
            {columns.map((c) => (
              <th
                key={c}
                style={{
                  textAlign: "start",
                  padding: "6px 8px",
                  borderBottom: "1px solid var(--color-border)",
                  whiteSpace: "nowrap",
                }}
              >
                {c}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i}>
              {r.map((cell, j) => (
                <td
                  key={j}
                  style={{
                    padding: "6px 8px",
                    borderBottom: "1px solid var(--color-border)",
                    whiteSpace: j === 0 ? "normal" : "nowrap",
                  }}
                >
                  {cell}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** CSV / Excel of one section, for the same period - the server builds both from the report's own queries. */
export function ExportButtons({
  section,
  from,
  to,
}: {
  section: string;
  from: string;
  to: string;
}) {
  const t = useT();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  async function download(format: "csv" | "xlsx") {
    setBusy(true);
    setError(false);
    try {
      const path = `/admin/analytics/export?${new URLSearchParams({ section, format, from, to })}`;
      const res = await fetch(`${API_BASE_URL}${path}`, {
        headers: authHeadersFor(path),
      });
      if (!res.ok) throw new Error(String(res.status));
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `via-analytics-${section}-${from}_${to}.${format}`;
      a.click();
      URL.revokeObjectURL(url);
    } catch {
      setError(true);
    } finally {
      setBusy(false);
    }
  }
  return (
    <span
      style={{
        display: "inline-flex",
        gap: 6,
        flexWrap: "wrap",
        alignItems: "center",
      }}
    >
      <button
        type="button"
        className="button button-secondary"
        disabled={busy}
        onClick={() => void download("csv")}
        data-testid={`an-export-csv-${section}`}
      >
        {t("an.export_csv")}
      </button>
      <button
        type="button"
        className="button button-secondary"
        disabled={busy}
        onClick={() => void download("xlsx")}
        data-testid={`an-export-xlsx-${section}`}
      >
        {t("an.export_xlsx")}
      </button>
      {error && (
        <span
          role="alert"
          style={{ color: "var(--color-danger)", fontSize: 12.5 }}
        >
          {t("an.export_failed")}
        </span>
      )}
    </span>
  );
}
