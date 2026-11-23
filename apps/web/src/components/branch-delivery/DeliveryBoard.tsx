"use client";

import Link from "next/link";
import { useEffect, useState, type ReactNode } from "react";
import DeliveryLeadTimeCard from "@/components/DeliveryLeadTimeCard";
import { useBranchWorkspace } from "@/components/owner/BranchWorkspace";
import { ApiError } from "@/lib/api";
import { isUnauthorized } from "@/lib/apiErrors";
import {
  addWindow,
  closeDay,
  deleteWindow,
  fetchBoard,
  ordersHref,
  pauseWindow,
  reopenDay,
  reopenWindowDate,
  resumeWindow,
  stopDay,
  stopWindowDate,
  updateWindow,
  type ActiveOrdersDetails,
  type BoardDay,
  type BoardWindow,
  type DeliveryBoard as Board,
  type TemplateWindow,
} from "@/lib/branchDelivery";
import { useLang, useT } from "@/lib/useLang";
import { useSessionExpiredRedirect } from "@/lib/useSessionExpiredRedirect";
import DwDialog from "./DwDialog";
import "./deliveryBoard.css";

const fill = (s: string, v: Record<string, string | number>) => s.replace(/\{(\w+)\}/g, (_, k: string) => String(v[k] ?? ""));
const span = (w: { start_time: string; end_time: string }) => `${w.start_time}–${w.end_time}`;
/** A time range inside running text: isolated left-to-right, so "16:00–20:00" never flips in Arabic. */
const isoSpan = (w: { start_time: string; end_time: string }) => `\u2066${span(w)}\u2069`;

type Dialog =
  | { kind: "add" }
  | { kind: "capacity" | "pause" | "resume" | "delete"; w: TemplateWindow }
  | { kind: "stopDate" | "reopenDate"; w: BoardWindow; date: string }
  | { kind: "stopDay" | "closeDay" | "reopenDay"; date: string }
  | { kind: "sheet"; title: string; actions: { label: string; open: Dialog; testId: string }[] };

/**
 * «نوافذ التوصيل v1»: the branch's delivery windows - a 7-day strip, the
 * chosen day's windows (state, booked / capacity, left, live checkouts, last
 * booking time, its orders by status, a link to the branch orders filtered
 * to it), the weekly template, then the preparation time card. Every state
 * is the server's (the one rule the shopper's slot list uses too). The owner
 * acts (inline on a computer, a bottom sheet on a phone); the branch
 * employee reads.
 */
export default function DeliveryBoard({ vendorId, branchId }: { vendorId: string; branchId: string }) {
  const t = useT();
  const lang = useLang();
  const ws = useBranchWorkspace(vendorId);
  const onExpired = useSessionExpiredRedirect();
  const [board, setBoard] = useState<Board | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [reload, setReload] = useState(0);
  const [picked, setPicked] = useState<string | null>(null);
  const [dialog, setDialog] = useState<Dialog | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    fetchBoard(vendorId, branchId).then(
      (b) => {
        if (!alive) return;
        setBoard(b);
        setLoadError(null);
      },
      (err: unknown) => {
        if (!alive) return;
        if (isUnauthorized(err)) {
          onExpired();
          return;
        }
        setLoadError(err instanceof ApiError && err.status === 403 ? "dw.err.forbidden" : "dw.err.load");
      },
    );
    return () => {
      alive = false;
    };
  }, [vendorId, branchId, reload, onExpired]);

  const owner = ws.isOwner;
  const done = (message: string) => {
    setDialog(null);
    setNotice(message);
    setReload((n) => n + 1);
  };

  if (loadError && !board) return <div className="error-banner" role="alert" data-testid="dw-error">{t(loadError)}</div>;
  if (!board) return <div className="skeleton" style={{ height: 320, width: "100%" }} aria-busy="true" />;

  const day = board.days.find((d) => d.date === picked) ?? board.days[0];
  const dayName = (d: { date: string; day_of_week: number }) =>
    d.date === board.today ? t("dw.today") : t(`dw.weekday.${d.day_of_week}`);
  const dateText = (date: string) => {
    const [, m, dd] = date.split("-");
    return `${Number(dd)}/${Number(m)}`;
  };
  const timeText = (iso: string) =>
    new Intl.DateTimeFormat(lang === "ar" ? "ar-PS-u-nu-latn" : "en-GB", { timeZone: "Asia/Hebron", weekday: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(new Date(iso));
  const dayLabel = `${dayName(day)} ${dateText(day.date)}`;

  // ---- owner actions (inline on a computer; a bottom sheet on a phone)
  const dayActions: { label: string; open: Dialog; testId: string }[] = [];
  if (owner && day.windows.length > 0 && day.status !== "PAST") {
    const anyStoppedOrClosed = day.windows.some((w) => w.status === "BOOKING_STOPPED" || (w.status === "CLOSED" && w.closed_source === "DATE"));
    if (day.windows.some((w) => w.status === "OPEN" || w.status === "FULL" || w.status === "CUTOFF_PASSED"))
      dayActions.push({ label: t("dw.act.stop_day"), open: { kind: "stopDay", date: day.date }, testId: "dw-act-stop-day" });
    if (day.status !== "CLOSED") dayActions.push({ label: t("dw.act.close_day"), open: { kind: "closeDay", date: day.date }, testId: "dw-act-close-day" });
    if (anyStoppedOrClosed) dayActions.push({ label: t("dw.act.reopen_day"), open: { kind: "reopenDay", date: day.date }, testId: "dw-act-reopen-day" });
  }
  const windowActions = (w: BoardWindow) => {
    const list: { label: string; open: Dialog; testId: string }[] = [];
    if (!owner) return list;
    if (w.status === "OPEN" || w.status === "FULL" || w.status === "CUTOFF_PASSED")
      list.push({ label: t("dw.act.stop_date"), open: { kind: "stopDate", w, date: day.date }, testId: "dw-act-stop-date" });
    if (w.status === "BOOKING_STOPPED" || (w.status === "CLOSED" && w.closed_source === "DATE"))
      list.push({ label: t("dw.act.reopen_date"), open: { kind: "reopenDate", w, date: day.date }, testId: "dw-act-reopen-date" });
    return list;
  };
  const templateActions = (w: TemplateWindow) => {
    if (!owner) return [];
    const list: { label: string; open: Dialog; testId: string }[] = [
      { label: t("dw.act.edit_capacity"), open: { kind: "capacity", w }, testId: "dw-act-capacity" },
      w.paused
        ? { label: t("dw.act.resume"), open: { kind: "resume", w }, testId: "dw-act-resume" }
        : { label: t("dw.act.pause"), open: { kind: "pause", w }, testId: "dw-act-pause" },
    ];
    if (!w.has_order_history) list.push({ label: t("dw.act.delete"), open: { kind: "delete", w }, testId: "dw-act-delete" });
    return list;
  };
  const actionsUi = (list: { label: string; open: Dialog; testId: string }[], title: string, testId: string) =>
    list.length === 0 ? null : (
      <>
        <div className="dw-actions-inline" role="group" aria-label={title} data-testid={`${testId}-inline`}>
          {list.map((a) => (
            <button key={a.testId} type="button" className="dw-btn dw-btn-quiet" onClick={() => setDialog(a.open)} data-testid={a.testId}>
              {a.label}
            </button>
          ))}
        </div>
        <button type="button" className="dw-btn dw-btn-quiet dw-more" onClick={() => setDialog({ kind: "sheet", title, actions: list })} data-testid={`${testId}-more`} aria-haspopup="dialog">
          {t("dw.act.more")}
        </button>
      </>
    );

  const byWeekday = [0, 1, 2, 3, 4, 5, 6]
    .map((d) => ({ d, windows: board.template.filter((w) => w.day_of_week === d) }))
    .filter((g) => g.windows.length > 0);

  return (
    <div className="dw" data-testid="dw">
      <header className="dw-head">
        <h1 className="dw-title">{t("dw.title")}</h1>
        <p className="dw-muted">{t("dw.intro")}</p>
        {!owner && <p className="dw-muted" data-testid="dw-read-only">{t("dw.read_only")}</p>}
      </header>
      <p className={notice ? "dw-notice" : "visually-hidden"} role="status" aria-live="polite" data-testid="dw-notice">{notice}</p>

      <section aria-labelledby="dw-days-title">
        <h2 id="dw-days-title" className="visually-hidden">{t("dw.days")}</h2>
        <div className="dw-strip" role="group" aria-label={t("dw.days")} data-testid="dw-strip">
          {board.days.map((d) => {
            const booked = d.windows.reduce((n, w) => n + w.booked, 0);
            const cap = d.windows.reduce((n, w) => n + w.capacity, 0);
            return (
              <button
                key={d.date}
                type="button"
                className={`dw-day is-${d.status}${d.date === day.date ? " is-on" : ""}`}
                aria-pressed={d.date === day.date}
                onClick={() => setPicked(d.date)}
                data-testid={`dw-day-${d.date}`}
              >
                <span className="dw-day-name">{dayName(d)}</span>
                <span className="dw-day-date">{dateText(d.date)}</span>
                <span className="dw-day-status">{t(`dw.day.${d.status}`)}</span>
                {d.windows.length > 0 && <span className="dw-day-load">{fill(t("dw.booked"), { booked, capacity: cap })}</span>}
              </button>
            );
          })}
        </div>
      </section>

      <section className="dw-dayview" aria-labelledby="dw-day-title" data-testid="dw-dayview">
        <div className="dw-dayview-head">
          <div>
            <h2 id="dw-day-title" className="dw-h2">{dayLabel}</h2>
            <p className="dw-muted">
              <span className={`dw-badge is-${day.status}`} data-testid="dw-day-status">{t(`dw.day.${day.status}`)}</span>
              {day.closed_reason && <span> · {fill(t("dw.reason"), { reason: day.closed_reason })}</span>}
              {day.closed_source === "BRANCH_CLOSURE" && <span> · {t("dw.closed.branch")}</span>}
              {day.active_orders > 0 && (
                <>
                  {" · "}
                  <Link href={ordersHref(vendorId, branchId, day.date)} className="dw-link" data-testid="dw-day-orders">
                    {t("dw.orders_day_link")} ({day.active_orders})
                  </Link>
                </>
              )}
            </p>
          </div>
          {actionsUi(dayActions, t("dw.day_actions"), "dw-day-actions")}
        </div>
        {day.windows.length === 0 ? (
          <p className="dw-muted" data-testid="dw-no-windows">{t("dw.no_windows_day")}</p>
        ) : (
          <ul className="dw-wins" data-testid="dw-wins">
            {day.windows.map((w) => (
              <li key={w.window_id} className={`dw-win is-${w.status}`} data-testid={`dw-win-${w.window_id}`} data-status={w.status}>
                <div className="dw-win-top">
                  <span className="dw-win-time" dir="ltr">{span(w)}</span>
                  <span className={`dw-badge is-${w.status}`} data-testid="dw-win-status">{t(`dw.status.${w.status}`)}</span>
                </div>
                <p className="dw-win-load">
                  <b>{fill(t("dw.booked"), { booked: w.booked, capacity: w.capacity })}</b>
                  {" · "}
                  {fill(t("dw.remaining"), { n: w.remaining })}
                  {w.active_holds > 0 && <> · {fill(t("dw.holds"), { n: w.active_holds })}</>}
                </p>
                {w.reason && <p className="dw-muted">{fill(t("dw.reason"), { reason: w.reason })}</p>}
                {w.closed_source === "BRANCH_CLOSURE" && <p className="dw-muted">{t("dw.closed.branch")}</p>}
                {(w.status === "OPEN" || w.status === "FULL") && <p className="dw-muted">{fill(t("dw.deadline"), { time: timeText(w.booking_deadline) })}</p>}
                {Object.keys(w.orders_by_status).length > 0 && (
                  <ul className="dw-ostatus" aria-label={t("dw.orders_link")}>
                    {Object.entries(w.orders_by_status).map(([st, n]) => (
                      <li key={st}>{t(`dw.ostatus.${st}`)} <b>{n}</b></li>
                    ))}
                  </ul>
                )}
                <div className="dw-win-foot">
                  <Link href={ordersHref(vendorId, branchId, day.date, w)} className="dw-link" data-testid="dw-win-orders">{t("dw.orders_link")}</Link>
                  {actionsUi(windowActions(w), `${t("dw.window_actions")} ${isoSpan(w)}`, "dw-win-actions")}
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="dw-template" aria-labelledby="dw-template-title" data-testid="dw-template">
        <div className="dw-dayview-head">
          <div>
            <h2 id="dw-template-title" className="dw-h2">{t("dw.template")}</h2>
            <p className="dw-muted">{t("dw.template_intro")}</p>
          </div>
          {owner && (
            <button type="button" className="dw-btn" onClick={() => setDialog({ kind: "add" })} data-testid="dw-add">{t("dw.add")}</button>
          )}
        </div>
        {byWeekday.length === 0 ? (
          <p className="dw-muted">{t("dw.template_empty")}</p>
        ) : (
          <div className="dw-week">
            {byWeekday.map((g) => (
              <div key={g.d} className="dw-week-day">
                <h3 className="dw-h3">{t(`dw.weekday.${g.d}`)}</h3>
                <ul className="dw-tpl-list">
                  {g.windows.map((w) => (
                    <li key={w.id} className={`dw-tpl${w.paused ? " is-paused" : ""}`} data-testid={`dw-tpl-${w.id}`}>
                      <span className="dw-win-time" dir="ltr">{span(w)}</span>
                      <span>{fill(t("dw.capacity"), { n: w.capacity })}</span>
                      {w.paused && <span className="dw-badge is-PAUSED">{t("dw.paused_badge")}</span>}
                      {w.has_order_history && <span className="dw-badge is-history">{t("dw.has_history")}</span>}
                      {w.paused && w.paused_reason && <span className="dw-muted">{fill(t("dw.reason"), { reason: w.paused_reason })}</span>}
                      {actionsUi(templateActions(w), `${t("dw.window_actions")} ${isoSpan(w)}`, "dw-tpl-actions")}
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        )}
      </section>

      <DeliveryLeadTimeCard vendorId={vendorId} branchId={branchId} canEdit={owner} />

      {dialog && (
        <DialogFor
          dialog={dialog}
          vendorId={vendorId}
          branchId={branchId}
          dayText={(date) => {
            const d = board.days.find((x) => x.date === date);
            return d ? `${dayName(d)} ${dateText(date)}` : date;
          }}
          onOpen={setDialog}
          onClose={() => setDialog(null)}
          onDone={done}
        />
      )}
    </div>
  );
}

/** Every owner action: one dialog each (a bottom sheet on a phone). */
function DialogFor({
  dialog,
  vendorId,
  branchId,
  dayText,
  onOpen,
  onClose,
  onDone,
}: {
  dialog: Dialog;
  vendorId: string;
  branchId: string;
  dayText: (date: string) => string;
  onOpen: (d: Dialog) => void;
  onClose: () => void;
  onDone: (message: string) => void;
}) {
  const t = useT();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ReactNode | null>(null);
  const [reason, setReason] = useState("");
  const [capacity, setCapacity] = useState(dialog.kind === "capacity" ? dialog.w.capacity : 5);
  const [days, setDays] = useState<number[]>([]);
  const [start, setStart] = useState("10:00");
  const [end, setEnd] = useState("14:00");

  if (dialog.kind === "sheet") {
    return (
      <DwDialog title={dialog.title} onClose={onClose} busy={false} testId="dw-sheet">
        <ul className="dw-sheet-list">
          {dialog.actions.map((a) => (
            <li key={a.testId}>
              <button type="button" className="dw-btn dw-btn-quiet dw-sheet-btn" onClick={() => onOpen(a.open)} data-testid={`${a.testId}-sheet`}>{a.label}</button>
            </li>
          ))}
        </ul>
        <div className="dw-dialog-actions">
          <button type="button" className="dw-btn dw-btn-quiet" onClick={onClose}>{t("dw.cancel")}</button>
        </div>
      </DwDialog>
    );
  }

  const needsReason = dialog.kind !== "add" && dialog.kind !== "delete";
  const tw = "w" in dialog ? isoSpan(dialog.w) : "";
  const date = "date" in dialog ? dialog.date : "";
  const title =
    dialog.kind === "add" ? t("dw.dlg.add")
      : dialog.kind === "capacity" ? fill(t("dw.dlg.capacity"), { time: tw })
      : dialog.kind === "pause" ? fill(t("dw.dlg.pause"), { time: tw })
      : dialog.kind === "resume" ? fill(t("dw.dlg.resume"), { time: tw })
      : dialog.kind === "delete" ? fill(t("dw.dlg.delete"), { time: tw })
      : dialog.kind === "stopDate" ? fill(t("dw.dlg.stop_date"), { time: tw, date: dayText(date) })
      : dialog.kind === "reopenDate" ? fill(t("dw.dlg.reopen_date"), { time: tw, date: dayText(date) })
      : dialog.kind === "stopDay" ? fill(t("dw.dlg.stop_day"), { date: dayText(date) })
      : dialog.kind === "closeDay" ? fill(t("dw.dlg.close_day"), { date: dayText(date) })
      : fill(t("dw.dlg.reopen_day"), { date: dayText(date) });
  const note =
    dialog.kind === "pause" ? t("dw.dlg.pause_note")
      : dialog.kind === "delete" ? t("dw.dlg.delete_note")
      : dialog.kind === "stopDate" || dialog.kind === "stopDay" ? t("dw.dlg.stop_note")
      : dialog.kind === "closeDay" ? t("dw.dlg.close_note")
      : null;

  const explain = (err: unknown): ReactNode => {
    if (!(err instanceof ApiError)) return t("dw.err.generic");
    if (err.code === "DAY_HAS_ACTIVE_ORDERS" || err.code === "DATE_HAS_ACTIVE_ORDERS") {
      const d = (err.details?.[0] ?? null) as ActiveOrdersDetails | null;
      const when = d?.dates?.[0] ?? date;
      return (
        <>
          {fill(t("dw.dlg.blocked"), { n: d?.active_orders ?? 0 })}{" "}
          <Link href={ordersHref(vendorId, branchId, when)} className="dw-link" data-testid="dw-blocked-orders">{t("dw.orders_day_link")}</Link>
        </>
      );
    }
    if (err.code === "CAPACITY_BELOW_BOOKINGS") {
      const d = (err.details?.[0] ?? {}) as { booked?: number; date?: string };
      return fill(t("dw.err.CAPACITY_BELOW_BOOKINGS"), { booked: d.booked ?? "", date: d.date ? dayText(d.date) : "" });
    }
    const key = `dw.err.${err.code}`;
    const text = t(key);
    return text === key ? t("dw.err.generic") : text;
  };

  async function submit() {
    setError(null);
    if (needsReason && reason.trim().length < 3) {
      setError(t("dw.err.reason"));
      return;
    }
    if (dialog.kind === "add") {
      if (days.length === 0) return setError(t("dw.err.days"));
      if (!(start < end)) return setError(t("dw.err.time"));
    }
    setBusy(true);
    try {
      const r = reason.trim();
      switch (dialog.kind) {
        case "add": {
          let added = 0;
          for (const d of days) {
            try {
              await addWindow(vendorId, branchId, { day_of_week: d, start_time: start, end_time: end, capacity });
              added += 1;
            } catch (err) {
              if (added > 0) onDone(fill(t("dw.added_n"), { n: added }));
              throw err;
            }
          }
          onDone(added === 1 ? t("dw.added") : fill(t("dw.added_n"), { n: added }));
          return;
        }
        case "capacity": await updateWindow(vendorId, branchId, dialog.w, capacity, r); break;
        case "pause": await pauseWindow(vendorId, branchId, dialog.w.id, r); break;
        case "resume": await resumeWindow(vendorId, branchId, dialog.w.id, r); break;
        case "delete": await deleteWindow(vendorId, branchId, dialog.w.id); break;
        case "stopDate": await stopWindowDate(vendorId, branchId, dialog.w.window_id, dialog.date, r); break;
        case "reopenDate": await reopenWindowDate(vendorId, branchId, dialog.w.window_id, dialog.date, r); break;
        case "stopDay": await stopDay(vendorId, branchId, dialog.date, r); break;
        case "closeDay": await closeDay(vendorId, branchId, dialog.date, r); break;
        case "reopenDay": await reopenDay(vendorId, branchId, dialog.date, r); break;
      }
      onDone(t("dw.saved"));
    } catch (err) {
      setError(explain(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <DwDialog title={title} onClose={onClose} busy={busy} testId={`dw-dlg-${dialog.kind}`}>
      <form
        className="dw-form"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        {note && <p className="dw-muted">{note}</p>}
        {dialog.kind === "add" && (
          <>
            <fieldset className="dw-days-pick">
              <legend>{t("dw.f.days")}</legend>
              {[0, 1, 2, 3, 4, 5, 6].map((d) => (
                <label key={d} className="dw-check">
                  <input
                    type="checkbox"
                    checked={days.includes(d)}
                    onChange={(e) => setDays((cur) => (e.target.checked ? [...cur, d] : cur.filter((x) => x !== d)))}
                    data-testid={`dw-f-day-${d}`}
                  />
                  <span>{t(`dw.weekday.${d}`)}</span>
                </label>
              ))}
            </fieldset>
            <div className="dw-row">
              <label className="dw-field">
                <span>{t("dw.f.start")}</span>
                <input type="time" className="dw-input" value={start} onChange={(e) => setStart(e.target.value)} required data-testid="dw-f-start" />
              </label>
              <label className="dw-field">
                <span>{t("dw.f.end")}</span>
                <input type="time" className="dw-input" value={end} onChange={(e) => setEnd(e.target.value)} required data-testid="dw-f-end" />
              </label>
            </div>
          </>
        )}
        {(dialog.kind === "add" || dialog.kind === "capacity") && (
          <label className="dw-field">
            <span>{t("dw.f.capacity")}</span>
            <input type="number" min={1} max={500} inputMode="numeric" className="dw-input dw-input-num" value={capacity} onChange={(e) => setCapacity(Math.max(1, Number(e.target.value) || 1))} required data-testid="dw-f-capacity" />
          </label>
        )}
        {needsReason && (
          <label className="dw-field">
            <span>{t("dw.f.reason")}</span>
            <input className="dw-input" value={reason} maxLength={300} onChange={(e) => setReason(e.target.value)} aria-describedby="dw-reason-hint" data-testid="dw-f-reason" />
            <small id="dw-reason-hint" className="dw-muted">{t("dw.f.reason_hint")}</small>
          </label>
        )}
        {error && <p className="error-banner" role="alert" data-testid="dw-dlg-error">{error}</p>}
        <div className="dw-dialog-actions">
          <button type="submit" className={`dw-btn${dialog.kind === "delete" || dialog.kind === "closeDay" ? " dw-btn-danger" : ""}`} disabled={busy} data-testid="dw-dlg-submit">
            {busy ? t("dw.saving") : dialog.kind === "add" || dialog.kind === "capacity" ? t("dw.save") : t("dw.confirm")}
          </button>
          <button type="button" className="dw-btn dw-btn-quiet" onClick={onClose} disabled={busy}>{t("dw.cancel")}</button>
        </div>
      </form>
    </DwDialog>
  );
}

export type { BoardDay };
