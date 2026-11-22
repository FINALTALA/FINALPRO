"use client";

import { useEffect, useId, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import SafeImage from "@/components/SafeImage";
import { cameraPossible, startCameraReader } from "@/components/pos/BarcodeScanner";
import {
  actionErrorKey,
  exactTime,
  lateBy,
  money,
  relativeTime,
  runOrderAction,
  saveInternalNote,
  statusKey,
  windowLabel,
  type ActionKey,
  type OrderDetail,
  type QueueAction,
  type TimelineEvent,
} from "@/lib/branchOrders";
import { isUnauthorized } from "@/lib/apiErrors";
import { fillBo } from "@/lib/branchOrdersText";
import type { Lang } from "@/lib/i18n";
import { useSessionExpiredRedirect } from "@/lib/useSessionExpiredRedirect";
import OrderTimeline from "./OrderTimeline";

const noSubscribe = () => () => {};

/** A real modal (native <dialog>): focus stays inside, Escape closes, the page behind is inert. */
function Modal({
  title,
  onClose,
  busy,
  children,
  testId,
}: {
  title: string;
  onClose: () => void;
  busy: boolean;
  children: ReactNode;
  testId: string;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  useEffect(() => {
    const d = ref.current;
    if (d && !d.open) d.showModal();
    return () => {
      if (d?.open) d.close();
    };
  }, []);
  return (
    <dialog
      ref={ref}
      className="bo-dialog"
      aria-labelledby={titleId}
      data-testid={testId}
      onCancel={(e) => {
        e.preventDefault();
        if (!busy) onClose();
      }}
    >
      <h2 id={titleId} className="bo-dialog-title">{title}</h2>
      {children}
    </dialog>
  );
}

/**
 * The pickup code: typed, read by a store scanner (it types and presses
 * Enter) or by the camera. Six digits only; nothing here ever shows the
 * order's own code - the server compares it at hand-over.
 */
function PickupCodeField({
  value,
  onChange,
  onEnter,
  disabled,
  t,
}: {
  value: string;
  onChange: (v: string) => void;
  onEnter: () => void;
  disabled: boolean;
  t: (k: string) => string;
}) {
  const id = useId();
  const canCamera = useSyncExternalStore(noSubscribe, cameraPossible, () => false);
  const [camera, setCamera] = useState(false);
  const [cameraError, setCameraError] = useState(false);
  const videoRef = useRef<HTMLVideoElement>(null);
  const stopper = useRef<{ stop: () => void } | null>(null);
  useEffect(() => () => stopper.current?.stop(), []);
  async function start() {
    setCameraError(false);
    setCamera(true);
    await new Promise((r) => window.setTimeout(r, 0));
    if (!videoRef.current) return;
    try {
      stopper.current = await startCameraReader(videoRef.current, (code) => {
        const digits = code.replace(/\D/g, "").slice(0, 6);
        stopper.current?.stop();
        stopper.current = null;
        setCamera(false);
        onChange(digits);
      });
    } catch {
      setCamera(false);
      setCameraError(true);
    }
  }
  function stop() {
    stopper.current?.stop();
    stopper.current = null;
    setCamera(false);
  }
  return (
    <div className="bo-code">
      <label htmlFor={id} className="bo-label">{t("bo.handover.code")}</label>
      <div className="bo-code-row">
        <input
          id={id}
          className="bo-input bo-code-input"
          inputMode="numeric"
          autoComplete="off"
          spellCheck={false}
          maxLength={6}
          pattern="\d{6}"
          dir="ltr"
          value={value}
          disabled={disabled}
          aria-describedby={`${id}-hint`}
          onChange={(e) => onChange(e.target.value.replace(/\D/g, "").slice(0, 6))}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              onEnter();
            }
          }}
          autoFocus
          data-testid="bo-code-input"
        />
        {canCamera && (
          <button type="button" className="bo-btn bo-btn-quiet" onClick={() => (camera ? stop() : void start())} disabled={disabled}>
            {camera ? t("bo.handover.camera_stop") : t("bo.handover.camera")}
          </button>
        )}
      </div>
      <p id={`${id}-hint`} className="bo-muted">{t("bo.handover.code_hint")}</p>
      {camera && <video ref={videoRef} className="bo-camera" muted playsInline aria-hidden="true" />}
      {cameraError && <p className="bo-muted" role="status">{t("bo.handover.camera_error")}</p>}
    </div>
  );
}

type Dialog = null | "pickup_handover" | "cancel" | "mark_delivered" | "mark_delivery_failed" | "approve_refund";
const DIALOG_ACTIONS: ActionKey[] = ["pickup_handover", "cancel", "mark_delivered", "mark_delivery_failed", "approve_refund"];

export default function OrderDetailView({
  vendorId,
  branchId,
  order,
  events,
  truncated,
  isOwner,
  lang,
  t,
  onChanged,
  onNotice,
  headingRef,
  backButton,
}: {
  vendorId: string;
  branchId: string;
  order: OrderDetail;
  events: TimelineEvent[] | null;
  truncated: boolean;
  isOwner: boolean;
  lang: Lang;
  t: (k: string) => string;
  /** reload the order, its timeline and the queue */
  onChanged: () => Promise<void> | void;
  onNotice: (text: string) => void;
  headingRef: React.RefObject<HTMLHeadingElement | null>;
  backButton: ReactNode;
}) {
  const onExpired = useSessionExpiredRedirect();
  const [dialog, setDialog] = useState<Dialog>(null);
  const [busy, setBusy] = useState<ActionKey | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [code, setCode] = useState("");
  const [reason, setReason] = useState("");
  const [editingNote, setEditingNote] = useState(false);
  const [note, setNote] = useState(order.internal_store_note ?? "");
  const menuRef = useRef<HTMLDivElement>(null);
  const noteRef = useRef<HTMLTextAreaElement>(null);

  // (a different order mounts a new view - the parent keys it by the order id)
  useEffect(() => {
    if (!menuOpen) return;
    const close = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setMenuOpen(false);
    };
    const esc = (e: KeyboardEvent) => {
      if (e.key === "Escape") setMenuOpen(false);
    };
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", esc);
    return () => {
      document.removeEventListener("mousedown", close);
      document.removeEventListener("keydown", esc);
    };
  }, [menuOpen]);

  const primary = order.actions.find((a) => a.primary) ?? null;
  const secondary = order.actions.filter((a) => !a.primary);
  const cancelAction = order.actions.find((a) => a.key === "cancel") ?? null;
  const failedAction = order.actions.find((a) => a.key === "mark_delivery_failed") ?? null;
  const due = windowLabel(order.scheduled_date, order.window, lang);
  const n = order.number;

  async function run(key: ActionKey, body: Record<string, unknown> = {}) {
    setBusy(key);
    setError(null);
    try {
      await runOrderAction(vendorId, branchId, order.id, key, body);
      setDialog(null);
      setCode("");
      setReason("");
      onNotice(t(`bo.done.${key}`));
      await onChanged();
    } catch (err) {
      if (isUnauthorized(err)) return onExpired();
      const k = actionErrorKey(err);
      setError(t(k));
      if (key === "pickup_handover" && k === "bo.err.wrong_code") setCode("");
      if (k === "bo.err.changed") await onChanged();
    } finally {
      setBusy(null);
    }
  }

  function choose(a: QueueAction) {
    setMenuOpen(false);
    setError(null);
    if (a.key === "internal_note") {
      setNote(order.internal_store_note ?? "");
      setEditingNote(true);
      window.setTimeout(() => noteRef.current?.focus(), 0);
      return;
    }
    if (DIALOG_ACTIONS.includes(a.key)) {
      setDialog(a.key as Dialog);
      return;
    }
    void run(a.key);
  }

  async function submitNote() {
    const text = note.trim();
    if (!text) {
      setError(t("bo.note.required"));
      return;
    }
    setBusy("internal_note");
    setError(null);
    try {
      await saveInternalNote(vendorId, branchId, order.id, text);
      setEditingNote(false);
      onNotice(t("bo.done.internal_note"));
      await onChanged();
    } catch (err) {
      if (isUnauthorized(err)) return onExpired();
      setError(t(actionErrorKey(err)));
    } finally {
      setBusy(null);
    }
  }

  const reasonValid = (required: boolean) => {
    const r = reason.trim();
    return required ? r.length >= 10 : r.length === 0 || r.length >= 10;
  };
  const dialogError = dialog && error ? <p className="bo-error" role="alert">{error}</p> : null;

  return (
    <article className="bo-detail" aria-labelledby="bo-detail-title" data-testid="bo-detail" data-order-id={order.id}>
      <div className="bo-detail-scroll">
        {backButton}
        {/* الملخص */}
        <section className="bo-sec" aria-labelledby="bo-detail-title">
          <div className="bo-detail-head">
            <h2 id="bo-detail-title" ref={headingRef} tabIndex={-1} className="bo-detail-title">
              {fillBo(t("bo.order_n"), { n })}
            </h2>
            <span className={`bo-chip is-${order.status.toLowerCase()}`} data-testid="bo-detail-status">{t(statusKey(order.status))}</span>
          </div>
          <dl className="bo-facts">
            <div>
              <dt>{t("bo.filter.method")}</dt>
              <dd>
                <MethodIcon method={order.fulfilment_method} /> {t(`bo.method.${order.fulfilment_method}`)}
              </dd>
            </div>
            <div>
              <dt>{t("bo.created")}</dt>
              <dd>
                <time dateTime={order.created_at} title={exactTime(order.created_at, lang)}>{exactTime(order.created_at, lang)}</time>
                <span className="bo-muted"> · {relativeTime(order.created_at, lang)}</span>
              </dd>
            </div>
            <div>
              <dt>{t("bo.due")}</dt>
              <dd data-testid="bo-detail-slot">{due ?? t("bo.no_slot")}</dd>
            </div>
          </dl>
          {order.is_late && order.due_at && (
            <p className="bo-late-banner" data-testid="bo-detail-late">{fillBo(t("bo.late_banner"), { t: lateBy(order.due_at, lang) })}</p>
          )}
          {order.not_received.open && (
            <p className="bo-warn">
              {t("bo.not_received")}
              {order.not_received.reason ? ` - ${fillBo(t("bo.not_received_reason"), { r: order.not_received.reason })}` : ""}
            </p>
          )}
          {order.status === "DELIVERY_FAILED" && <p className="bo-warn">{t("bo.failed_wait")}</p>}
          {order.delivery_attempt_count > 0 && <p className="bo-muted">{fillBo(t("bo.attempts"), { n: order.delivery_attempt_count })}</p>}
          {order.cancellation_reason && <p className="bo-muted" dir="auto">{fillBo(t("bo.cancellation_reason"), { r: order.cancellation_reason })}</p>}
          {order.is_own_order && <p className="bo-muted">{t("bo.own_order")}</p>}
        </section>

        {/* العناصر */}
        <section className="bo-sec" aria-labelledby="bo-sec-items">
          <h3 id="bo-sec-items" className="bo-sec-title">
            {t("bo.sec.items")} <span className="bo-muted">({order.item_count === 1 ? t("bo.item_one") : fillBo(t("bo.items_n"), { n: order.item_count })})</span>
          </h3>
          <ul className="bo-items" data-testid="bo-items">
            {order.items.map((i) => {
              const title = lang === "en" && i.title_en ? i.title_en : i.title_ar;
              const colour = lang === "en" ? (i.color_name_en ?? i.color_name_ar) : (i.color_name_ar ?? i.color_name_en);
              return (
                <li key={i.id} className={`bo-item${i.cancelled ? " is-cancelled" : ""}`} data-testid="bo-item">
                  <span className="bo-item-img">
                    <SafeImage src={i.image_url} alt={title} width={56} height={56} loading="lazy" />
                  </span>
                  <span className="bo-item-text">
                    <strong dir="auto">{title}</strong>
                    <span className="bo-item-meta">
                      {colour && (
                        <span>
                          {i.color_hex && <span className="bo-swatch" style={{ background: i.color_hex }} aria-hidden="true" />}
                          {t("bo.color")}: <span dir="auto">{colour}</span>
                        </span>
                      )}
                      {i.size_label && (
                        <span>
                          {t("bo.size")}: <bdi>{i.size_label}</bdi>
                        </span>
                      )}
                      {i.cancelled && <span className="bo-chip is-cancelled">{t("bo.cancelled_item")}</span>}
                    </span>
                  </span>
                  <span className="bo-item-qty">
                    <span className="visually-hidden">{t("bo.qty")}: </span>×{i.quantity}
                    {isOwner && i.unit_price !== undefined && <span className="bo-muted bo-item-price">{money(i.line_total, lang)}</span>}
                  </span>
                </li>
              );
            })}
          </ul>
        </section>

        {/* العميلة والدفع */}
        <section className="bo-sec" aria-labelledby="bo-sec-customer">
          <h3 id="bo-sec-customer" className="bo-sec-title">{t("bo.sec.customer")}</h3>
          <dl className="bo-facts">
            <div>
              <dt>{t("bo.customer")}</dt>
              <dd dir="auto" data-testid="bo-customer-name">{order.customer.name ?? "—"}</dd>
            </div>
            <div>
              <dt>{t("bo.phone")}</dt>
              <dd>
                <a href={`tel:${order.customer.phone}`} dir="ltr" className="bo-link">{order.customer.phone}</a>
              </dd>
            </div>
            <div>
              <dt>{t("bo.payment")}</dt>
              <dd>{order.payment.method === "COD" ? t("bo.pay.cod") : t("bo.pay.online")}</dd>
            </div>
            {isOwner && order.payment.total !== undefined && (
              <>
                <div>
                  <dt>{t("bo.subtotal")}</dt>
                  <dd>{money(order.payment.subtotal, lang)}</dd>
                </div>
                {order.payment.delivery_fee !== null && order.payment.delivery_fee !== undefined && (
                  <div>
                    <dt>{t("bo.delivery_fee")}</dt>
                    <dd>{money(order.payment.delivery_fee, lang)}</dd>
                  </div>
                )}
                <div>
                  <dt>{t("bo.total")}</dt>
                  <dd data-testid="bo-total">{money(order.payment.total, lang)}</dd>
                </div>
                {(order.payment.refunded ?? 0) > 0 && (
                  <div>
                    <dt>{t("bo.refunded")}</dt>
                    <dd>{money(order.payment.refunded, lang)}</dd>
                  </div>
                )}
              </>
            )}
            {order.payment.amount_due !== null && order.payment.cod_collected_amount === null && order.bucket !== "done" && (
              <div className="is-strong">
                <dt>{t("bo.amount_due")}</dt>
                <dd data-testid="bo-amount-due">{money(order.payment.amount_due, lang)}</dd>
              </div>
            )}
            {order.payment.cod_collected_amount !== null && (
              <div>
                <dt>{t("bo.collected")}</dt>
                <dd>{money(order.payment.cod_collected_amount, lang)}</dd>
              </div>
            )}
          </dl>
        </section>

        {/* الملاحظات */}
        <section className="bo-sec" aria-labelledby="bo-sec-notes">
          <h3 id="bo-sec-notes" className="bo-sec-title">{t("bo.sec.notes")}</h3>
          <p className="bo-label">{t("bo.customer_note")}</p>
          <p className="bo-note" dir="auto">{order.customer_note || <span className="bo-muted">{t("bo.no_note")}</span>}</p>
          <p className="bo-label">{t("bo.internal_note")}</p>
          {editingNote ? (
            <div className="bo-note-edit">
              <label htmlFor="bo-note-input" className="visually-hidden">{t("bo.internal_note")}</label>
              <textarea
                id="bo-note-input"
                ref={noteRef}
                className="bo-input"
                rows={3}
                maxLength={1000}
                dir="auto"
                value={note}
                placeholder={t("bo.note.placeholder")}
                onChange={(e) => setNote(e.target.value)}
                data-testid="bo-note-input"
              />
              {!dialog && error && busy === null && <p className="bo-error" role="alert">{error}</p>}
              <div className="bo-row">
                <button type="button" className="bo-btn bo-btn-primary" disabled={busy !== null} aria-busy={busy === "internal_note"} onClick={() => void submitNote()} data-testid="bo-note-save">
                  {t("bo.save")}
                </button>
                <button type="button" className="bo-btn bo-btn-quiet" disabled={busy !== null} onClick={() => { setEditingNote(false); setNote(order.internal_store_note ?? ""); setError(null); }}>
                  {t("bo.cancel_edit")}
                </button>
              </div>
            </div>
          ) : (
            <p className="bo-note" dir="auto" data-testid="bo-internal-note">{order.internal_store_note || <span className="bo-muted">{t("bo.no_note")}</span>}</p>
          )}
        </section>

        {/* السجل */}
        <section className="bo-sec" aria-labelledby="bo-sec-timeline">
          <h3 id="bo-sec-timeline" className="bo-sec-title">{t("bo.sec.timeline")}</h3>
          <OrderTimeline events={events} truncated={truncated} lang={lang} t={t} />
        </section>
      </div>

      {/* شريط الإجراءات: خطوة واحدة أساسية، والباقي في قائمة */}
      <div className="bo-actionbar" role="group" aria-label={t("bo.actions")} data-testid="bo-actionbar">
        {!dialog && !editingNote && error && <p className="bo-error" role="alert">{error}</p>}
        <div className="bo-actionbar-row">
          {primary ? (
            <button
              type="button"
              className="bo-btn bo-btn-primary bo-btn-wide"
              disabled={busy !== null}
              aria-busy={busy === primary.key}
              onClick={() => choose(primary)}
              data-testid={`bo-action-${primary.key}`}
            >
              {t(`bo.a.${primary.key}`)}
            </button>
          ) : (
            <p className="bo-muted bo-no-action">{t("bo.no_action")}</p>
          )}
          {secondary.length > 0 && (
            <div className="bo-menu" ref={menuRef}>
              <button
                type="button"
                className="bo-btn bo-btn-quiet"
                aria-expanded={menuOpen}
                aria-controls="bo-more-menu"
                disabled={busy !== null}
                onClick={() => setMenuOpen((o) => !o)}
                data-testid="bo-more"
              >
                {t("bo.more_actions")} <span aria-hidden="true">▾</span>
              </button>
              {menuOpen && (
                <ul id="bo-more-menu" className="bo-menu-list">
                  {secondary.map((a) => (
                    <li key={a.key}>
                      <button
                        type="button"
                        className={`bo-menu-item${a.key === "cancel" ? " is-danger" : ""}`}
                        onClick={() => choose(a)}
                        data-testid={`bo-action-${a.key}`}
                      >
                        {t(`bo.a.${a.key}`)}
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
        </div>
      </div>

      {dialog === "pickup_handover" && (
        <Modal title={fillBo(t("bo.handover.title"), { n })} busy={busy !== null} onClose={() => { setDialog(null); setError(null); setCode(""); }} testId="bo-handover">
          <p>{t("bo.handover.lead")}</p>
          <dl className="bo-facts bo-facts-tight">
            <div>
              <dt>{t("bo.customer")}</dt>
              <dd dir="auto">{order.customer.name ?? "—"}</dd>
            </div>
            <div>
              <dt>{t("bo.sec.items")}</dt>
              <dd>{order.item_count === 1 ? t("bo.item_one") : fillBo(t("bo.items_n"), { n: order.item_count })}</dd>
            </div>
          </dl>
          <p className={order.payment.amount_due !== null ? "bo-collect" : "bo-muted"} data-testid="bo-handover-collect">
            {order.payment.amount_due !== null ? fillBo(t("bo.handover.collect"), { amount: money(order.payment.amount_due, lang) }) : t("bo.handover.paid")}
          </p>
          <PickupCodeField
            value={code}
            onChange={(v) => { setCode(v); setError(null); }}
            onEnter={() => { if (code.length === 6) void run("pickup_handover", { pickup_code: code }); }}
            disabled={busy !== null}
            t={t}
          />
          {dialogError}
          <div className="bo-row bo-dialog-actions">
            <button type="button" className="bo-btn bo-btn-primary" disabled={code.length !== 6 || busy !== null} aria-busy={busy === "pickup_handover"} onClick={() => void run("pickup_handover", { pickup_code: code })} data-testid="bo-handover-submit">
              {t("bo.handover.submit")}
            </button>
            <button type="button" className="bo-btn bo-btn-quiet" disabled={busy !== null} onClick={() => { setDialog(null); setError(null); setCode(""); }}>
              {t("bo.close")}
            </button>
          </div>
        </Modal>
      )}

      {dialog === "cancel" && cancelAction && (
        <Modal title={fillBo(t("bo.cancel.title"), { n })} busy={busy !== null} onClose={() => { setDialog(null); setError(null); }} testId="bo-cancel">
          <p>{t("bo.cancel.lead")}</p>
          <label htmlFor="bo-cancel-reason" className="bo-label">{t("bo.cancel.reason")}</label>
          <textarea id="bo-cancel-reason" className="bo-input" rows={3} maxLength={1000} dir="auto" value={reason} onChange={(e) => setReason(e.target.value)} aria-describedby="bo-cancel-hint" autoFocus data-testid="bo-cancel-reason" />
          <p id="bo-cancel-hint" className="bo-muted">{cancelAction.reason === "required" ? t("bo.cancel.reason_required") : t("bo.cancel.reason_optional")}</p>
          {dialogError}
          <div className="bo-row bo-dialog-actions">
            <button
              type="button"
              className="bo-btn bo-btn-danger"
              disabled={busy !== null}
              aria-busy={busy === "cancel"}
              onClick={() => {
                if (!reasonValid(cancelAction.reason === "required")) {
                  setError(t(cancelAction.reason === "required" ? "bo.err.reason_required" : "bo.err.reason_short"));
                  return;
                }
                void run("cancel", reason.trim() ? { reason: reason.trim() } : {});
              }}
              data-testid="bo-cancel-submit"
            >
              {t("bo.cancel.submit")}
            </button>
            <button type="button" className="bo-btn bo-btn-quiet" disabled={busy !== null} onClick={() => { setDialog(null); setError(null); }}>
              {t("bo.close")}
            </button>
          </div>
        </Modal>
      )}

      {dialog === "mark_delivered" && (
        <Modal title={fillBo(t("bo.delivered.title"), { n })} busy={busy !== null} onClose={() => { setDialog(null); setError(null); }} testId="bo-delivered">
          <p>{t("bo.delivered.lead")}</p>
          {order.payment.amount_due !== null && (
            <p className="bo-collect">{fillBo(t("bo.delivered.collect"), { amount: money(order.payment.amount_due, lang) })}</p>
          )}
          {dialogError}
          <div className="bo-row bo-dialog-actions">
            <button type="button" className="bo-btn bo-btn-primary" disabled={busy !== null} aria-busy={busy === "mark_delivered"} onClick={() => void run("mark_delivered")} data-testid="bo-delivered-submit" autoFocus>
              {t("bo.confirm")}
            </button>
            <button type="button" className="bo-btn bo-btn-quiet" disabled={busy !== null} onClick={() => { setDialog(null); setError(null); }}>
              {t("bo.close")}
            </button>
          </div>
        </Modal>
      )}

      {dialog === "mark_delivery_failed" && failedAction && (
        <Modal title={fillBo(t("bo.failed.title"), { n })} busy={busy !== null} onClose={() => { setDialog(null); setError(null); }} testId="bo-failed">
          <p>{t("bo.failed.lead")}</p>
          {failedAction.closes_order && <p className="bo-warn">{t("bo.failed.closes")}</p>}
          <label htmlFor="bo-failed-reason" className="bo-label">{t("bo.failed.reason")}</label>
          <textarea id="bo-failed-reason" className="bo-input" rows={2} maxLength={1000} dir="auto" value={reason} onChange={(e) => setReason(e.target.value)} autoFocus />
          {dialogError}
          <div className="bo-row bo-dialog-actions">
            <button
              type="button"
              className="bo-btn bo-btn-danger"
              disabled={busy !== null}
              aria-busy={busy === "mark_delivery_failed"}
              onClick={() => {
                if (!reasonValid(false)) {
                  setError(t("bo.err.reason_short"));
                  return;
                }
                void run("mark_delivery_failed", reason.trim() ? { reason: reason.trim() } : {});
              }}
              data-testid="bo-failed-submit"
            >
              {t("bo.confirm")}
            </button>
            <button type="button" className="bo-btn bo-btn-quiet" disabled={busy !== null} onClick={() => { setDialog(null); setError(null); }}>
              {t("bo.close")}
            </button>
          </div>
        </Modal>
      )}

      {dialog === "approve_refund" && (
        <Modal title={fillBo(t("bo.refund.title"), { n })} busy={busy !== null} onClose={() => { setDialog(null); setError(null); }} testId="bo-refund">
          <p>{t("bo.refund.lead")}</p>
          {dialogError}
          <div className="bo-row bo-dialog-actions">
            <button type="button" className="bo-btn bo-btn-primary" disabled={busy !== null} aria-busy={busy === "approve_refund"} onClick={() => void run("approve_refund")} data-testid="bo-refund-submit" autoFocus>
              {t("bo.confirm")}
            </button>
            <button type="button" className="bo-btn bo-btn-quiet" disabled={busy !== null} onClick={() => { setDialog(null); setError(null); }}>
              {t("bo.close")}
            </button>
          </div>
        </Modal>
      )}
    </article>
  );
}

export function MethodIcon({ method }: { method: "PICKUP" | "DELIVERY" }) {
  return (
    <svg className="bo-method" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {method === "PICKUP" ? (
        <>
          <path d="M4 9h16l-1.2 10.2a1 1 0 0 1-1 .8H6.2a1 1 0 0 1-1-.8z" />
          <path d="M8.5 9V7a3.5 3.5 0 0 1 7 0v2" />
        </>
      ) : (
        <>
          <path d="M3 6h11v10H3zM14 9h4l3 3v4h-7" />
          <circle cx="7" cy="17.5" r="1.8" />
          <circle cx="17" cy="17.5" r="1.8" />
        </>
      )}
    </svg>
  );
}
