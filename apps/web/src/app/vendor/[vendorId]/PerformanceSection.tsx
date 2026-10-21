"use client";

import { useEffect, useState } from "react";
import { ApiError, apiFetch } from "@/lib/api";

// Sprint 25 (FR-VEND-011, FR-VPORTAL-007) - review round: the owner's
// "آخر 30 يوماً" section with its own loading / error-with-retry /
// not-enough-data states, and two small charts over the API's weekly
// buckets (Part 5: "performance charts ... data-table fallback"). Still
// omitted entirely when the dashboard flag is off - the API's 404
// FEATURE_DISABLED is not a failure worth alarming the owner about.

interface PerformanceWeek {
  week_from: string;
  week_to: string;
  terminal_orders_count: number;
  cancelled_orders_count: number;
  cancellation_rate: number | null;
  responded_orders_count: number;
  average_response_time_hours: number | null;
}

interface VendorPerformanceDto {
  cancellation_rate: number | null;
  average_response_time_hours: number | null;
  responded_orders_count: number;
  rating_average: number | null;
  rating_count: number;
  terminal_orders_count: number;
  cancelled_orders_count: number;
  weekly: PerformanceWeek[];
}

type LoadState =
  | { kind: "loading" }
  | { kind: "disabled" }
  | { kind: "error"; message: string }
  | { kind: "ready"; data: VendorPerformanceDto };

// Validated with the dataviz palette checker on the card surface
// (#fffdf9): lightness, chroma, CVD separation (dE 12.3) and contrast.
const COMPLETED_COLOR = "#0f9488";
const CANCELLED_COLOR = "#d9622b";
// Single-series chart: one neutral hue, no legend (its title names it).
const RESPONSE_COLOR = "#1f3557";

function formatPercent(v: number | null): string {
  if (v === null) return "-";
  return `${(v * 100).toFixed(1)}%`;
}

function formatHours(v: number | null): string {
  if (v === null) return "-";
  if (v >= 1) return `${v.toFixed(1)} ساعة`;
  if (v * 60 >= 1) return `${Math.round(v * 60)} دقيقة`;
  return "أقل من دقيقة";
}

// The response chart's unit follows its data, so its axis never reads
// "0.0, 0.0, 0" for fast responders: hours, else minutes, else seconds.
function responseUnit(maxHours: number): { label: string; factor: number } {
  if (maxHours >= 1) return { label: "ساعة", factor: 1 };
  if (maxHours * 60 >= 1) return { label: "دقيقة", factor: 60 };
  return { label: "ثانية", factor: 3600 };
}

// Whole percent in the charts/table, so they never repeat the tiles'
// exact one-decimal figures.
function wholePercent(v: number | null): string {
  return v === null ? "لا بيانات" : `${Math.round(v * 100)}٪`;
}

function weekLabel(w: PerformanceWeek): string {
  const d = new Date(w.week_from);
  return `${d.getUTCDate()}/${d.getUTCMonth() + 1}`;
}

function weekRange(w: PerformanceWeek): string {
  const fmt = (iso: string) =>
    new Date(iso).toLocaleDateString("ar", { day: "numeric", month: "long", timeZone: "UTC" });
  return `${fmt(w.week_from)} - ${fmt(w.week_to)}`;
}

/** A "nice" upper bound for an axis that starts at 0. */
function niceMax(v: number): number {
  if (v <= 0) return 1;
  const pow = 10 ** Math.floor(Math.log10(v));
  const step = [1, 2, 5, 10].find((s) => s * pow >= v) ?? 10;
  return step * pow;
}

const W = 340;
const H = 170;
const PAD = { top: 12, right: 8, bottom: 24, left: 30 };
const PLOT_W = W - PAD.left - PAD.right;
const PLOT_H = H - PAD.top - PAD.bottom;

function ColumnChart({
  title,
  weeks,
  max,
  segments,
  describe,
  legend,
  integer = false,
}: {
  title: string;
  /** Counts: whole-number ticks only. */
  integer?: boolean;
  legend?: { label: string; color: string }[];
  weeks: PerformanceWeek[];
  max: number;
  /** Bottom-to-top stack per week; a single entry is a plain column. */
  segments: (w: PerformanceWeek) => { value: number; color: string }[];
  describe: (w: PerformanceWeek) => string[];
}) {
  const [hover, setHover] = useState<number | null>(null);
  const band = PLOT_W / weeks.length;
  const barW = Math.min(28, band * 0.56);
  const y = (v: number) => PAD.top + PLOT_H - (v / max) * PLOT_H;
  const ticks = integer ? (max <= 1 ? [0, 1] : [0, Math.round(max / 2), max]) : [0, max / 2, max];

  return (
    <figure className="perf-chart">
      <figcaption>{title}</figcaption>
      {legend && (
        <div className="perf-legend">
          {legend.map((l) => (
            <span key={l.label}>
              <i style={{ background: l.color }} aria-hidden="true" /> {l.label}
            </span>
          ))}
        </div>
      )}
      <div className="perf-chart-plot" dir="ltr">
        <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={title}>
          {ticks.map((t) => (
            <g key={t}>
              <line x1={PAD.left} x2={W - PAD.right} y1={y(t)} y2={y(t)} className={t === 0 ? "perf-axis" : "perf-grid"} />
              <text x={PAD.left - 6} y={y(t) + 3.5} textAnchor="end" className="perf-tick">
                {Number.isInteger(t) ? t : t.toFixed(1)}
              </text>
            </g>
          ))}
          {weeks.map((w, i) => {
            const cx = PAD.left + band * i + band / 2;
            let acc = 0;
            const segs = segments(w).filter((s) => s.value > 0);
            return (
              <g key={w.week_from}>
                {segs.map((s, j) => {
                  const top = y(acc + s.value);
                  const bottom = y(acc);
                  acc += s.value;
                  const isTop = j === segs.length - 1;
                  // 2px surface gap between stacked segments.
                  const h = Math.max(0, bottom - top - (j > 0 ? 2 : 0));
                  const r = isTop ? Math.min(4, h / 2) : 0;
                  return (
                    <path
                      key={j}
                      fill={s.color}
                      opacity={hover === null || hover === i ? 1 : 0.45}
                      d={
                        `M${cx - barW / 2},${top + h}` +
                        `V${top + r}` +
                        (r ? `Q${cx - barW / 2},${top} ${cx - barW / 2 + r},${top}` : "") +
                        `H${cx + barW / 2 - r}` +
                        (r ? `Q${cx + barW / 2},${top} ${cx + barW / 2},${top + r}` : "") +
                        `V${top + h}Z`
                      }
                    />
                  );
                })}
                <text x={cx} y={H - 8} textAnchor="middle" className="perf-tick">
                  {weekLabel(w)}
                </text>
                {/* Hit target: the whole column band, larger than the mark. */}
                <rect
                  x={PAD.left + band * i}
                  y={PAD.top}
                  width={band}
                  height={PLOT_H}
                  fill="transparent"
                  tabIndex={0}
                  aria-label={`${weekRange(w)}: ${describe(w).join("، ")}`}
                  onMouseEnter={() => setHover(i)}
                  onMouseLeave={() => setHover(null)}
                  onFocus={() => setHover(i)}
                  onBlur={() => setHover(null)}
                />
              </g>
            );
          })}
        </svg>
        {hover !== null && (
          <div
            className="perf-tooltip"
            role="status"
            dir="rtl"
            style={{
              left: `${((PAD.left + band * hover + band / 2) / W) * 100}%`,
            }}
          >
            <strong>{weekRange(weeks[hover])}</strong>
            {describe(weeks[hover]).map((line) => (
              <span key={line}>{line}</span>
            ))}
          </div>
        )}
      </div>
    </figure>
  );
}

export default function PerformanceSection({ vendorId }: { vendorId: string }) {
  const [attempt, setAttempt] = useState(0);
  const [state, setState] = useState<{ attempt: number; value: LoadState }>({
    attempt: -1,
    value: { kind: "loading" },
  });

  useEffect(() => {
    let cancelled = false;
    apiFetch<VendorPerformanceDto>(`/vendors/${vendorId}/performance`)
      .then((data) => {
        if (!cancelled) setState({ attempt, value: { kind: "ready", data } });
      })
      .catch((err) => {
        if (cancelled) return;
        if (err instanceof ApiError && err.code === "FEATURE_DISABLED") {
          setState({ attempt, value: { kind: "disabled" } });
        } else {
          setState({
            attempt,
            value: {
              kind: "error",
              message: err instanceof ApiError ? err.message : "تعذّر الاتصال بالخادم",
            },
          });
        }
      });
    return () => {
      cancelled = true;
    };
  }, [vendorId, attempt]);

  // A new attempt shows "loading" again until its own answer arrives.
  const current: LoadState = state.attempt === attempt ? state.value : { kind: "loading" };

  if (current.kind === "disabled") return null;

  if (current.kind === "loading") {
    return (
      <div className="card perf-card" aria-busy="true" aria-label="جارٍ تحميل مؤشرات الأداء">
        <div className="perf-skel" style={{ width: 200, height: 18 }} />
        <div className="perf-kpis">
          {[0, 1, 2, 3].map((i) => (
            <div key={i} className="perf-skel" style={{ width: 110, height: 44 }} />
          ))}
        </div>
        <div className="perf-skel" style={{ width: "100%", height: 150 }} />
      </div>
    );
  }

  if (current.kind === "error") {
    return (
      <div className="card perf-card" role="alert">
        <h3 style={{ marginTop: 0 }}>مؤشرات الأداء</h3>
        <p className="muted">تعذّر تحميل مؤشرات الأداء: {current.message}</p>
        <button className="button button-secondary" type="button" onClick={() => setAttempt((n) => n + 1)}>
          إعادة المحاولة
        </button>
      </div>
    );
  }

  const d = current.data;
  const hasOrders = d.terminal_orders_count > 0 || d.responded_orders_count > 0;
  const weeks = d.weekly ?? [];
  const maxOrders = niceMax(Math.max(...weeks.map((w) => w.terminal_orders_count), 0));
  const unit = responseUnit(Math.max(...weeks.map((w) => w.average_response_time_hours ?? 0), 0));
  const maxResponse = niceMax(
    Math.max(...weeks.map((w) => (w.average_response_time_hours ?? 0) * unit.factor), 0),
  );

  return (
    <div className="card perf-card">
      <h3 style={{ marginTop: 0 }}>مؤشرات الأداء (آخر 30 يوماً)</h3>

      <div className="perf-kpis">
        <div>
          <div className="muted">معدّل الإلغاء</div>
          <div className="perf-kpi-value">{formatPercent(d.cancellation_rate)}</div>
        </div>
        <div>
          <div className="muted">متوسط زمن الاستجابة</div>
          <div className="perf-kpi-value">{formatHours(d.average_response_time_hours)}</div>
        </div>
        <div>
          <div className="muted">عدد الطلبات المستجاب لها</div>
          <div className="perf-kpi-value">{d.responded_orders_count}</div>
        </div>
        <div>
          <div className="muted">التقييم</div>
          <div className="perf-kpi-value">
            {d.rating_average === null ? "-" : `${d.rating_average.toFixed(1)} (${d.rating_count})`}
          </div>
        </div>
      </div>

      {!hasOrders ? (
        <p className="perf-empty">
          لا توجد بيانات كافية بعد - تظهر الرسوم البيانية بعد أول طلبات مكتملة أو ملغاة خلال آخر 30 يوماً.
        </p>
      ) : (
        <>
          <div className="perf-charts">
            <ColumnChart
              title="الطلبات المنتهية أسبوعياً"
              integer
              legend={[
                { label: "مكتملة", color: COMPLETED_COLOR },
                { label: "ملغاة", color: CANCELLED_COLOR },
              ]}
              weeks={weeks}
              max={maxOrders}
              segments={(w) => [
                { value: w.terminal_orders_count - w.cancelled_orders_count, color: COMPLETED_COLOR },
                { value: w.cancelled_orders_count, color: CANCELLED_COLOR },
              ]}
              describe={(w) => [
                `مكتملة: ${w.terminal_orders_count - w.cancelled_orders_count}`,
                `ملغاة: ${w.cancelled_orders_count}`,
                `نسبة الإلغاء: ${wholePercent(w.cancellation_rate)}`,
              ]}
            />
            <ColumnChart
              title={`متوسط زمن الاستجابة أسبوعياً (${unit.label})`}
              weeks={weeks}
              max={maxResponse}
              segments={(w) => [
                { value: (w.average_response_time_hours ?? 0) * unit.factor, color: RESPONSE_COLOR },
              ]}
              describe={(w) => [
                w.average_response_time_hours === null
                  ? "لا توجد طلبات مستجاب لها"
                  : `المتوسط: ${formatHours(w.average_response_time_hours)}`,
                `طلبات مستجاب لها: ${w.responded_orders_count}`,
              ]}
            />
          </div>
          <details className="perf-table">
            <summary>عرض البيانات كجدول</summary>
            <table className="data-table">
              <thead>
                <tr>
                  <th>الأسبوع</th>
                  <th>مكتملة</th>
                  <th>ملغاة</th>
                  <th>نسبة الإلغاء</th>
                  <th>متوسط الاستجابة</th>
                </tr>
              </thead>
              <tbody>
                {weeks.map((w) => (
                  <tr key={w.week_from}>
                    <td>{weekRange(w)}</td>
                    <td>{w.terminal_orders_count - w.cancelled_orders_count}</td>
                    <td>{w.cancelled_orders_count}</td>
                    <td>{wholePercent(w.cancellation_rate)}</td>
                    <td>{formatHours(w.average_response_time_hours)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </details>
        </>
      )}
    </div>
  );
}
