"use client";

import { useEffect, useState, type ReactNode } from "react";
import { useBranchWorkspace } from "@/components/owner/BranchWorkspace";
import DwDialog from "@/components/branch-delivery/DwDialog";
import { ApiError } from "@/lib/api";
import { isUnauthorized } from "@/lib/apiErrors";
import {
  addDays,
  cancelClosure,
  createClosure,
  ENDS,
  fetchClosures,
  fetchHours,
  hhmm,
  isoRange,
  palestineInstant,
  palestineParts,
  periodError,
  sameWeek,
  saveWeek,
  shortenClosure,
  sortPeriods,
  STARTS,
  todayInPalestine,
  type Closure,
  type OpeningState,
  type Period,
  type Week,
} from "@/lib/branchHours";
import { useT } from "@/lib/useLang";
import { useSessionExpiredRedirect } from "@/lib/useSessionExpiredRedirect";
import "@/components/branch-delivery/deliveryBoard.css";
import "./branchHours.css";

const fill = (s: string, v: Record<string, string | number>) => s.replace(/\{(\w+)\}/g, (_, k: string) => String(v[k] ?? ""));
const DAYS = [0, 1, 2, 3, 4, 5, 6];

type Dialog =
  | { kind: "period"; day: number; index: number | null }
  | { kind: "copy"; day: number }
  | { kind: "day"; day: number }
  | { kind: "cancel"; c: Closure }
  | { kind: "shorten"; c: Closure };

/**
 * «ساعات العمل والإغلاقات v1»: the branch's weekly hours (a week calendar on a
 * computer, day cards + a bottom sheet on a phone) kept as a DRAFT until «حفظ
 * الأسبوع» (the existing audited full-week PUT), a live summary from the
 * server's one opening rule, then the temporary closures (add; cancel a
 * future one; shorten one from now on; past ones folded away). The owner
 * edits; the branch employee reads (the server refuses every write from them anyway).
 */
export default function HoursBoard({ vendorId, branchId }: { vendorId: string; branchId: string }) {
  const t = useT();
  const ws = useBranchWorkspace(vendorId);
  const owner = ws.isOwner;
  const onExpired = useSessionExpiredRedirect();

  const [saved, setSaved] = useState<Week | null>(null);
  /** null = no edits (the saved week is shown) */
  const [draft, setDraft] = useState<Week | null>(null);
  const [opening, setOpening] = useState<OpeningState | null>(null);
  const [closures, setClosures] = useState<Closure[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [version, setVersion] = useState(0);
  const [now, setNow] = useState(() => Date.now());
  const [dialog, setDialog] = useState<Dialog | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let alive = true;
    Promise.all([fetchHours(vendorId, branchId), fetchClosures(vendorId, branchId)]).then(
      ([h, c]) => {
        if (!alive) return;
        setSaved(h.week);
        setOpening(h.opening);
        setClosures(c);
        setNow(Date.now());
        setLoadError(null);
      },
      (err: unknown) => {
        if (!alive) return;
        if (isUnauthorized(err)) {
          onExpired();
          return;
        }
        setLoadError(err instanceof ApiError && err.status === 403 ? "hb.err.forbidden" : "hb.err.load");
      },
    );
    return () => {
      alive = false;
    };
  }, [vendorId, branchId, version, onExpired]);

  const week = draft ?? saved;
  const dirty = draft !== null && saved !== null && !sameWeek(draft, saved);

  useEffect(() => {
    if (!dirty) return;
    const warn = (e: BeforeUnloadEvent) => {
      e.preventDefault();
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);

  if (loadError && !saved) return <div className="error-banner" role="alert" data-testid="hb-error">{t(loadError)}</div>;
  if (!week || !closures) return <div className="skeleton" style={{ height: 320, width: "100%" }} aria-busy="true" />;

  const dayName = (d: number) => t(`hb.wd.${d}`);
  const dayText = (d: number) =>
    week[d].length === 0 ? t("hb.closed") : week[d].map((p) => isoRange(p)).join(t("hb.periods_join"));
  const edit = (fn: (w: Week) => Week) => {
    setNotice(null);
    setSaveError(null);
    setDraft(fn(week.map((ps) => [...ps])));
  };

  // ---- "when" texts, Palestine time
  const today = todayInPalestine();
  const dateLabel = (date: string) => {
    const [, m, dd] = date.split("-");
    const dow = new Date(`${date}T00:00:00Z`).getUTCDay();
    return `${dayName(dow)} ${Number(dd)}/${Number(m)}`;
  };
  const whenText = (iso: string) => {
    const p = palestineParts(new Date(iso));
    const time = `⁦${hhmm(p.minute)}⁩`;
    if (p.date === today) return time;
    if (p.date === addDays(today, 1)) return `${t("hb.tomorrow")} ${time}`;
    return `${dateLabel(p.date)} ${time}`;
  };
  const summary = (() => {
    if (!opening || opening.open_now === null) return t("hb.now.unset");
    if (opening.open_now) {
      const head = fill(t("hb.now.open_until"), { time: whenText(opening.open_until!) });
      return opening.next_open_at ? `${head} · ${fill(t("hb.now.reopens"), { time: whenText(opening.next_open_at) })}` : head;
    }
    return `${t("hb.now.closed")} · ${opening.next_open_at ? fill(t("hb.now.opens"), { time: whenText(opening.next_open_at) }) : t("hb.now.no_next")}`;
  })();

  async function onSave() {
    if (!draft) return;
    setSaving(true);
    setSaveError(null);
    try {
      const w = await saveWeek(vendorId, branchId, draft);
      setSaved(w);
      setDraft(null);
      setNotice(t("hb.saved"));
      setVersion((n) => n + 1);
    } catch (err) {
      if (isUnauthorized(err)) return onExpired();
      setSaveError(
        err instanceof ApiError && err.status === 403
          ? t("hb.err.forbidden")
          : err instanceof ApiError && (err.code === "OVERLAPPING_PERIODS" || err.code === "INVALID_HOURS_STEP")
            ? t(`hb.err.${err.code}`)
            : t("hb.err.save"),
      );
    } finally {
      setSaving(false);
    }
  }

  // ---- the desktop week calendar: hour rows from the earliest opening to the latest closing
  const all = week.flat();
  const startH = Math.min(8, ...all.map((p) => Math.floor(p.open / 60)));
  const endH = Math.max(20, ...all.map((p) => Math.ceil(p.close / 60)));
  const span = (endH - startH) * 60;
  const hours = Array.from({ length: endH - startH + 1 }, (_, i) => startH + i);
  const blockStyle = (p: Period) => ({
    insetBlockStart: `${((p.open - startH * 60) / span) * 100}%`,
    blockSize: `${((p.close - p.open) / span) * 100}%`,
  });

  const periodButton = (d: number, i: number, p: Period, extra = "") =>
    owner ? (
      <button
        type="button"
        key={i}
        className={`hb-block ${extra}`}
        style={blockStyle(p)}
        data-testid={`hb-block-${d}-${i}`}
        aria-label={fill(t("hb.period_label"), { day: dayName(d), open: hhmm(p.open), close: hhmm(p.close) })}
        onClick={() => setDialog({ kind: "period", day: d, index: i })}
      >
        <span dir="ltr">{hhmm(p.open)}–{hhmm(p.close)}</span>
      </button>
    ) : (
      <div key={i} className={`hb-block is-static ${extra}`} style={blockStyle(p)} data-testid={`hb-block-${d}-${i}`}>
        <span dir="ltr">{hhmm(p.open)}–{hhmm(p.close)}</span>
      </div>
    );

  // ---- closures
  const state = (c: Closure) =>
    Date.parse(c.ends_at) <= now ? "past" : Date.parse(c.starts_at) <= now ? "active" : "upcoming";
  const closureRange = (c: Closure) => {
    const s = palestineParts(new Date(c.starts_at));
    const e = palestineParts(new Date(c.ends_at));
    if (s.minute === 0 && e.minute === 0) {
      const last = addDays(e.date, -1);
      return last === s.date
        ? `${dateLabel(s.date)} (${t("hc.whole_day")})`
        : `${fill(t("hc.range"), { from: dateLabel(s.date), to: dateLabel(last) })} (${t("hc.whole_days")})`;
    }
    const sTime = `⁦${hhmm(s.minute)}⁩`;
    const eTime = `⁦${hhmm(e.minute)}⁩`;
    if (s.date === e.date) return `${dateLabel(s.date)}، ⁦${hhmm(s.minute)}–${hhmm(e.minute)}⁩`;
    return fill(t("hc.range"), { from: `${dateLabel(s.date)} ${sTime}`, to: `${dateLabel(e.date)} ${eTime}` });
  };
  const current = closures.filter((c) => state(c) !== "past");
  const past = closures.filter((c) => state(c) === "past").reverse();
  const closureDone = (message: string) => {
    setDialog(null);
    setNotice(message);
    setVersion((n) => n + 1);
  };

  return (
    <div className="dw hb" data-testid="hb-root">
      <header className="dw-head">
        <h2 className="dw-title">{t("hb.title")}</h2>
        <p className="dw-muted">{t("hb.intro")}</p>
        {!owner && <p className="hb-readonly" data-testid="hb-readonly">{t("hb.readonly")}</p>}
      </header>

      <p className="hb-summary" role="status" data-testid="hb-summary">
        {summary}
        {dirty && <span className="hb-summary-note"> · {t("hb.now.draft_note")}</span>}
      </p>
      {notice && <p className="dw-notice" role="status" data-testid="hb-notice">{notice}</p>}

      {/* ---- the usual week */}
      <section className="hb-week" aria-labelledby="hb-week-h">
        <div className="hb-week-head">
          <div>
            <h3 className="dw-h2" id="hb-week-h">{t("hb.week")}</h3>
            <p className="dw-muted">{t("hb.week_intro")}</p>
          </div>
          {owner && (
            <div className="hb-savebar">
              {dirty && <span className="dw-badge is-FULL" data-testid="hb-unsaved">{t("hb.unsaved")}</span>}
              {dirty && (
                <button type="button" className="dw-btn dw-btn-quiet" onClick={() => { setDraft(null); setSaveError(null); }} disabled={saving} data-testid="hb-discard">
                  {t("hb.discard")}
                </button>
              )}
              <button type="button" className="dw-btn" onClick={onSave} disabled={!dirty || saving} data-testid="hb-save">
                {t("hb.save_week")}
              </button>
            </div>
          )}
        </div>
        {saveError && <div className="error-banner" role="alert" data-testid="hb-save-error">{saveError}</div>}

        {/* computer: a week calendar, Sunday..Saturday columns, hour rows */}
        <div className="hb-cal" data-testid="hb-grid" style={{ ["--hb-rows" as string]: endH - startH }}>
          <div className="hb-cal-corner" aria-hidden="true" />
          {DAYS.map((d) => (
            <div key={d} className="hb-cal-dayhead">
              <span className="hb-cal-dayname">{dayName(d)}</span>
              {owner && (
                <span className="hb-cal-dayacts">
                  <button type="button" className="hb-mini-btn" onClick={() => setDialog({ kind: "period", day: d, index: null })} data-testid={`hb-add-${d}`} aria-label={`${t("hb.add_period")} - ${dayName(d)}`}>
                    {t("hb.add_period")}
                  </button>
                  <button type="button" className="hb-mini-btn hb-dots" onClick={() => setDialog({ kind: "day", day: d })} data-testid={`hb-menu-${d}`} aria-label={fill(t("hb.day_menu"), { day: dayName(d) })}>
                    ⋯
                  </button>
                </span>
              )}
            </div>
          ))}
          <div className="hb-cal-axis" aria-hidden="true">
            {hours.map((h) => (
              <span key={h} className="hb-cal-hour" style={{ insetBlockStart: `${((h - startH) / (endH - startH)) * 100}%` }}>
                {hhmm(h * 60)}
              </span>
            ))}
          </div>
          {DAYS.map((d) => (
            <div key={d} className="hb-cal-col" data-testid={`hb-col-${d}`} role="group" aria-label={fill(t("hb.day_summary"), { day: dayName(d), text: dayText(d) })}>
              {week[d].length === 0 && <span className="hb-cal-closed">{t("hb.closed")}</span>}
              {week[d].map((p, i) => periodButton(d, i, p))}
            </div>
          ))}
        </div>

        {/* phone: day cards (a tap opens a bottom sheet) + a read-only mini week */}
        <div className="hb-phone">
          <ul className="hb-cards" data-testid="hb-cards">
            {DAYS.map((d) => {
              const body = (
                <>
                  <span className="hb-card-day">{dayName(d)}</span>
                  <span className={`hb-card-text${week[d].length === 0 ? " is-closed" : ""}`}>{dayText(d)}</span>
                </>
              );
              return (
                <li key={d}>
                  {owner ? (
                    <button type="button" className="hb-card" onClick={() => setDialog({ kind: "day", day: d })} data-testid={`hb-card-${d}`}>
                      {body}
                      <span className="hb-card-chev" aria-hidden="true">‹</span>
                    </button>
                  ) : (
                    <div className="hb-card" data-testid={`hb-card-${d}`}>{body}</div>
                  )}
                </li>
              );
            })}
          </ul>
          <figure className="hb-miniweek" aria-hidden="true">
            <figcaption className="dw-muted">{t("hb.mini")}</figcaption>
            <div className="hb-miniweek-grid">
              {DAYS.map((d) => (
                <div key={d} className="hb-miniweek-day">
                  <span className="hb-miniweek-col">
                    {week[d].map((p, i) => (
                      <span key={i} className="hb-miniweek-block" style={blockStyle(p)} />
                    ))}
                  </span>
                  <span className="hb-miniweek-name">{t(`hb.wds.${d}`)}</span>
                </div>
              ))}
            </div>
          </figure>
        </div>
      </section>

      {/* ---- closures and holidays */}
      <section className="hc" aria-labelledby="hc-h" data-testid="hc-root">
        <h3 className="dw-h2" id="hc-h">{t("hc.title")}</h3>
        <p className="dw-muted">{t("hc.intro")}</p>
        {owner && <ClosureForm vendorId={vendorId} branchId={branchId} today={today} onDone={() => closureDone(t("hc.added"))} />}

        <h4 className="dw-h3">{t("hc.upcoming")}</h4>
        {current.length === 0 ? (
          <p className="dw-muted" data-testid="hc-none">{t("hc.none")}</p>
        ) : (
          <ul className="hc-list">
            {current.map((c) => (
              <ClosureItem key={c.id} c={c} st={state(c)} range={closureRange(c)}>
                {owner && (
                  <span className="dw-actions-inline hc-acts">
                    {state(c) === "upcoming" && (
                      <button type="button" className="dw-btn dw-btn-quiet" onClick={() => setDialog({ kind: "cancel", c })} data-testid="hc-cancel">
                        {t("hc.cancel")}
                      </button>
                    )}
                    <button type="button" className="dw-btn dw-btn-quiet" onClick={() => setDialog({ kind: "shorten", c })} data-testid="hc-shorten">
                      {t("hc.shorten")}
                    </button>
                  </span>
                )}
              </ClosureItem>
            ))}
          </ul>
        )}
        {past.length > 0 && (
          <details className="hc-history" data-testid="hc-history">
            <summary>{fill(t("hc.history"), { n: past.length })}</summary>
            <ul className="hc-list">
              {past.map((c) => (
                <ClosureItem key={c.id} c={c} st="past" range={closureRange(c)} />
              ))}
            </ul>
          </details>
        )}
      </section>

      {dialog?.kind === "period" && (
        <PeriodDialog
          day={dialog.day}
          dayName={dayName(dialog.day)}
          periods={week[dialog.day]}
          index={dialog.index}
          onClose={() => setDialog(null)}
          onSave={(ps) => {
            edit((w) => {
              w[dialog.day] = sortPeriods(ps);
              return w;
            });
            setDialog(null);
          }}
        />
      )}
      {dialog?.kind === "copy" && (
        <CopyDialog
          day={dialog.day}
          dayName={dayName}
          onClose={() => setDialog(null)}
          onApply={(days) => {
            edit((w) => {
              for (const d of days) w[d] = w[dialog.day].map((p) => ({ ...p }));
              return w;
            });
            setDialog(null);
          }}
        />
      )}
      {dialog?.kind === "day" && (
        <DwDialog title={fill(t("hb.dlg.day"), { day: dayName(dialog.day) })} onClose={() => setDialog(null)} busy={false} testId="hb-dialog-day">
          <div className="dw-form">
            {week[dialog.day].length === 0 ? (
              <p className="dw-muted">{t("hb.closed")}</p>
            ) : (
              <ul className="dw-sheet-list">
                {week[dialog.day].map((p, i) => (
                  <li key={i}>
                    <button type="button" className="dw-btn dw-btn-quiet dw-sheet-btn" onClick={() => setDialog({ kind: "period", day: dialog.day, index: i })} data-testid={`hb-day-period-${i}`}>
                      {fill(t("hb.edit_period"), { range: isoRange(p), day: dayName(dialog.day) })}
                    </button>
                  </li>
                ))}
              </ul>
            )}
            <ul className="dw-sheet-list">
              <li>
                <button type="button" className="dw-btn dw-sheet-btn" onClick={() => setDialog({ kind: "period", day: dialog.day, index: null })} data-testid="hb-day-add">
                  {t("hb.add_period")}
                </button>
              </li>
              <li>
                <button type="button" className="dw-btn dw-btn-quiet dw-sheet-btn" onClick={() => setDialog({ kind: "copy", day: dialog.day })} data-testid="hb-day-copy">
                  {t("hb.copy_day")}
                </button>
              </li>
              {week[dialog.day].length > 0 && (
                <li>
                  <button
                    type="button"
                    className="dw-btn dw-btn-quiet dw-sheet-btn"
                    data-testid="hb-day-close"
                    onClick={() => {
                      const d = dialog.day;
                      edit((w) => {
                        w[d] = [];
                        return w;
                      });
                      setDialog(null);
                      setNotice(fill(t("hb.day_closed_note"), { day: dayName(d) }));
                    }}
                  >
                    {t("hb.close_day")}
                  </button>
                </li>
              )}
            </ul>
            <div className="dw-dialog-actions">
              <button type="button" className="dw-btn dw-btn-quiet" onClick={() => setDialog(null)}>{t("hb.done")}</button>
            </div>
          </div>
        </DwDialog>
      )}
      {(dialog?.kind === "cancel" || dialog?.kind === "shorten") && (
        <ClosureChangeDialog
          kind={dialog.kind}
          c={dialog.c}
          range={closureRange(dialog.c)}
          started={state(dialog.c) === "active"}
          today={today}
          onClose={() => setDialog(null)}
          onSubmit={async (reason, endsAt) => {
            if (dialog.kind === "cancel") {
              await cancelClosure(vendorId, branchId, dialog.c.id, reason);
              closureDone(t("hc.cancelled"));
            } else {
              await shortenClosure(vendorId, branchId, dialog.c.id, endsAt!, reason);
              closureDone(t("hc.shortened"));
            }
          }}
        />
      )}
    </div>
  );
}

function ClosureItem({ c, st, range, children }: { c: Closure; st: string; range: string; children?: ReactNode }) {
  const t = useT();
  return (
    <li className={`hc-item is-${st}`} data-testid="hc-item" data-state={st}>
      <div className="hc-item-main">
        <span className={`dw-badge ${st === "active" ? "is-CLOSED" : st === "upcoming" ? "is-PAUSED" : "is-PAST"}`}>{t(`hc.state.${st}`)}</span>
        <span className="hc-range">{range}</span>
        {c.reason && <span className="dw-muted">{fill(t("hc.reason"), { reason: c.reason })}</span>}
      </div>
      {children}
    </li>
  );
}

function TimeSelect({ value, options, onChange, label, testId }: { value: number; options: number[]; onChange: (v: number) => void; label: string; testId: string }) {
  return (
    <label className="dw-field">
      {label}
      <select className="dw-input" value={value} onChange={(e) => onChange(Number(e.target.value))} data-testid={testId} dir="ltr">
        {options.map((m) => (
          <option key={m} value={m}>{hhmm(m)}</option>
        ))}
      </select>
    </label>
  );
}

function PeriodDialog({
  day,
  dayName,
  periods,
  index,
  onClose,
  onSave,
}: {
  day: number;
  dayName: string;
  periods: Period[];
  index: number | null;
  onClose: () => void;
  onSave: (ps: Period[]) => void;
}) {
  const t = useT();
  const existing = index === null ? null : periods[index];
  // a new period: right after the last one (or 09:00-17:00 on an empty day)
  const last = periods[periods.length - 1];
  const fresh = last ? { open: Math.min(last.close + 60, 1380), close: Math.min(last.close + 240, 1440) } : { open: 540, close: 1020 };
  const [p, setP] = useState<Period>(existing ?? fresh);
  const [error, setError] = useState<string | null>(null);
  const title = existing ? fill(t("hb.edit_period"), { range: isoRange(existing), day: dayName }) : fill(t("hb.dlg.add"), { day: dayName });
  return (
    <DwDialog title={title} onClose={onClose} busy={false} testId="hb-dialog-period">
      <form
        className="dw-form"
        onSubmit={(e) => {
          e.preventDefault();
          const err = periodError(periods, p, index ?? -1);
          if (err) return setError(t(`hb.err.${err}`));
          const next = [...periods];
          if (index === null) next.push(p);
          else next[index] = p;
          onSave(next);
        }}
      >
        {error && <div className="error-banner" role="alert" data-testid="hb-period-error">{error}</div>}
        <div className="dw-row">
          <TimeSelect label={t("hb.f.open")} value={p.open} options={STARTS} onChange={(open) => setP({ ...p, open })} testId="hb-open" />
          <TimeSelect label={t("hb.f.close")} value={p.close} options={ENDS} onChange={(close) => setP({ ...p, close })} testId="hb-close" />
        </div>
        <div className="dw-dialog-actions">
          <button type="submit" className="dw-btn" data-testid="hb-period-save">{t("hb.save")}</button>
          {index !== null && (
            <button type="button" className="dw-btn dw-btn-danger" data-testid="hb-period-delete" onClick={() => onSave(periods.filter((_, i) => i !== index))}>
              {t("hb.delete")}
            </button>
          )}
          <button type="button" className="dw-btn dw-btn-quiet" onClick={onClose}>{t("hb.cancel")}</button>
        </div>
        <input type="hidden" value={day} readOnly />
      </form>
    </DwDialog>
  );
}

function CopyDialog({ day, dayName, onClose, onApply }: { day: number; dayName: (d: number) => string; onClose: () => void; onApply: (days: number[]) => void }) {
  const t = useT();
  const [days, setDays] = useState<number[]>([]);
  const [error, setError] = useState<string | null>(null);
  return (
    <DwDialog title={fill(t("hb.dlg.copy"), { day: dayName(day) })} onClose={onClose} busy={false} testId="hb-dialog-copy">
      <form
        className="dw-form"
        onSubmit={(e) => {
          e.preventDefault();
          if (days.length === 0) return setError(t("hb.err.no_days"));
          onApply(days);
        }}
      >
        {error && <div className="error-banner" role="alert">{error}</div>}
        <fieldset className="dw-days-pick">
          <legend>{t("hb.f.days")}</legend>
          {DAYS.filter((d) => d !== day).map((d) => (
            <label key={d} className="dw-check">
              <input
                type="checkbox"
                checked={days.includes(d)}
                onChange={(e) => setDays(e.target.checked ? [...days, d] : days.filter((x) => x !== d))}
                data-testid={`hb-copy-day-${d}`}
              />
              {dayName(d)}
            </label>
          ))}
        </fieldset>
        <p className="dw-muted">{fill(t("hb.copy_note"), { day: dayName(day) })}</p>
        <div className="dw-dialog-actions">
          <button type="submit" className="dw-btn" data-testid="hb-copy-apply">{t("hb.apply")}</button>
          <button type="button" className="dw-btn dw-btn-quiet" onClick={onClose}>{t("hb.cancel")}</button>
        </div>
      </form>
    </DwDialog>
  );
}

function closureErrorText(t: (k: string) => string, err: unknown): string {
  if (err instanceof ApiError) {
    if (err.status === 403) return t("hb.err.forbidden");
    if (err.code === "BRANCH_CLOSURE_HAS_ACTIVE_ORDERS") {
      const d = (err.details?.[0] ?? {}) as { active_orders?: number };
      return fill(t("hc.err.BRANCH_CLOSURE_HAS_ACTIVE_ORDERS"), { n: d.active_orders ?? "" });
    }
    const key = `hc.err.${err.code}`;
    const text = t(key);
    if (text !== key) return text;
  }
  return t("hc.err.save");
}

function ClosureForm({ vendorId, branchId, today, onDone }: { vendorId: string; branchId: string; today: string; onDone: () => void }) {
  const t = useT();
  const onExpired = useSessionExpiredRedirect();
  const [kind, setKind] = useState<"days" | "hours">("days");
  const [from, setFrom] = useState(today);
  const [to, setTo] = useState(today);
  const [open, setOpen] = useState(12 * 60);
  const [close, setClose] = useState(16 * 60);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    setError(null);
    if (!from || (kind === "days" && !to)) return setError(t("hc.err.dates"));
    const startsAt = kind === "days" ? palestineInstant(from, 0) : palestineInstant(from, open);
    const endsAt = kind === "days" ? palestineInstant(to, 1440) : palestineInstant(from, close);
    if (startsAt.getTime() >= endsAt.getTime()) return setError(t("hc.err.range"));
    setBusy(true);
    try {
      await createClosure(vendorId, branchId, startsAt, endsAt, reason);
      setReason("");
      onDone();
    } catch (err) {
      if (isUnauthorized(err)) return onExpired();
      setError(closureErrorText(t, err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form
      className="hc-form"
      data-testid="hc-form"
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <h4 className="dw-h3">{t("hc.add")}</h4>
      {error && <div className="error-banner" role="alert" data-testid="hc-form-error">{error}</div>}
      <fieldset className="dw-days-pick">
        <legend>{t("hc.kind")}</legend>
        <label className="dw-check">
          <input type="radio" name="hc-kind" checked={kind === "days"} onChange={() => setKind("days")} data-testid="hc-kind-days" />
          {t("hc.kind.days")}
        </label>
        <label className="dw-check">
          <input type="radio" name="hc-kind" checked={kind === "hours"} onChange={() => setKind("hours")} data-testid="hc-kind-hours" />
          {t("hc.kind.hours")}
        </label>
      </fieldset>
      {kind === "days" ? (
        <div className="dw-row">
          <label className="dw-field">
            {t("hc.f.from_date")}
            <input type="date" className="dw-input" value={from} min={today} onChange={(e) => setFrom(e.target.value)} data-testid="hc-from-date" />
          </label>
          <label className="dw-field">
            {t("hc.f.to_date")}
            <input type="date" className="dw-input" value={to} min={from || today} onChange={(e) => setTo(e.target.value)} data-testid="hc-to-date" />
          </label>
        </div>
      ) : (
        <div className="hc-hours-row">
          <label className="dw-field">
            {t("hc.f.date")}
            <input type="date" className="dw-input" value={from} min={today} onChange={(e) => setFrom(e.target.value)} data-testid="hc-date" />
          </label>
          <TimeSelect label={t("hc.f.from")} value={open} options={STARTS} onChange={setOpen} testId="hc-from" />
          <TimeSelect label={t("hc.f.to")} value={close} options={ENDS} onChange={setClose} testId="hc-to" />
        </div>
      )}
      <label className="dw-field">
        {t("hc.f.reason_optional")}
        <input className="dw-input" value={reason} maxLength={500} onChange={(e) => setReason(e.target.value)} data-testid="hc-reason" />
      </label>
      <div>
        <button type="submit" className="dw-btn" disabled={busy} data-testid="hc-add">{t("hc.add")}</button>
      </div>
    </form>
  );
}

function ClosureChangeDialog({
  kind,
  c,
  range,
  started,
  today,
  onClose,
  onSubmit,
}: {
  kind: "cancel" | "shorten";
  c: Closure;
  range: string;
  started: boolean;
  today: string;
  onClose: () => void;
  onSubmit: (reason: string, endsAt: Date | null) => Promise<void>;
}) {
  const t = useT();
  const onExpired = useSessionExpiredRedirect();
  const [reason, setReason] = useState("");
  const [mode, setMode] = useState<"now" | "at">(started ? "now" : "at");
  const startDate = palestineParts(new Date(c.starts_at)).date;
  const [date, setDate] = useState(started ? today : startDate);
  const [minute, setMinute] = useState(() => {
    const s = palestineParts(new Date(c.starts_at));
    return Math.min(1440, Math.ceil((s.minute + 60) / 15) * 15);
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    setError(null);
    if (!reason.trim()) return setError(t("hc.err.reason"));
    const endsAt = kind === "cancel" ? null : mode === "now" ? new Date() : palestineInstant(date, minute);
    setBusy(true);
    try {
      await onSubmit(reason.trim(), endsAt);
    } catch (err) {
      if (isUnauthorized(err)) return onExpired();
      setError(closureErrorText(t, err));
      setBusy(false);
    }
  }

  return (
    <DwDialog
      title={fill(t(kind === "cancel" ? "hc.dlg.cancel" : "hc.dlg.shorten"), { range })}
      onClose={onClose}
      busy={busy}
      testId={kind === "cancel" ? "hc-dialog-cancel" : "hc-dialog-shorten"}
    >
      <form
        className="dw-form"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        {error && <div className="error-banner" role="alert" data-testid="hc-dialog-error">{error}</div>}
        <p className="dw-muted">{t(kind === "cancel" ? "hc.dlg.cancel_note" : "hc.dlg.shorten_note")}</p>
        {kind === "shorten" && (
          <fieldset className="dw-days-pick">
            <legend>{t("hc.f.new_end")}</legend>
            {started && (
              <label className="dw-check">
                <input type="radio" name="hc-end" checked={mode === "now"} onChange={() => setMode("now")} data-testid="hc-end-now" />
                {t("hc.end_now")}
              </label>
            )}
            <label className="dw-check">
              <input type="radio" name="hc-end" checked={mode === "at"} onChange={() => setMode("at")} data-testid="hc-end-at" />
              {t("hc.f.end_at")}
            </label>
            {mode === "at" && (
              <div className="dw-row hc-end-at">
                <label className="dw-field">
                  {t("hc.f.date")}
                  <input type="date" className="dw-input" value={date} min={started ? today : startDate} onChange={(e) => setDate(e.target.value)} data-testid="hc-end-date" />
                </label>
                <TimeSelect label={t("hc.f.to")} value={minute} options={ENDS} onChange={setMinute} testId="hc-end-time" />
              </div>
            )}
          </fieldset>
        )}
        <label className="dw-field">
          {t("hc.f.reason_required")}
          <textarea className="dw-input" rows={2} value={reason} maxLength={500} onChange={(e) => setReason(e.target.value)} data-testid="hc-change-reason" />
        </label>
        <div className="dw-dialog-actions">
          <button type="submit" className={`dw-btn${kind === "cancel" ? " dw-btn-danger" : ""}`} disabled={busy} data-testid="hc-confirm">
            {t(kind === "cancel" ? "hc.cancel" : "hc.shorten")}
          </button>
          <button type="button" className="dw-btn dw-btn-quiet" onClick={onClose} disabled={busy}>{t("hb.cancel")}</button>
        </div>
      </form>
    </DwDialog>
  );
}
