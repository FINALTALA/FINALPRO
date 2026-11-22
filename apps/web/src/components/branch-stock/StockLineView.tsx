"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import SafeImage from "@/components/SafeImage";
import { isUnauthorized } from "@/lib/apiErrors";
import { exactTime, relativeTime } from "@/lib/branchOrders";
import {
  confirmCount,
  fetchLedger,
  needsSecondConfirm,
  postMovement,
  saveThreshold,
  stockErrorKey,
  type LedgerEntry,
  type MovementBody,
  type StockLineDetail,
} from "@/lib/branchStock";
import { fillSk } from "@/lib/branchStockText";
import type { Lang } from "@/lib/i18n";
import { useSessionExpiredRedirect } from "@/lib/useSessionExpiredRedirect";
import StockModal from "./StockModal";

type Form = null | "receive" | "count" | "damage" | "internal";

export function lineTitle(l: { title_ar: string; title_en: string }, lang: Lang) {
  return lang === "en" && l.title_en ? l.title_en : l.title_ar;
}
export function lineVariant(l: { color_name_ar: string | null; color_name_en: string | null; size_label: string | null }, lang: Lang) {
  const colour = lang === "en" ? (l.color_name_en ?? l.color_name_ar) : l.color_name_ar;
  return [colour, l.size_label].filter(Boolean).join(" · ");
}

/** Positive whole number from a field (null when it is not one). */
function wholePositive(raw: string): number | null {
  if (!/^\d{1,6}$/.test(raw.trim())) return null;
  const n = Number(raw.trim());
  return n > 0 ? n : null;
}

/**
 * One line (colour x size) of the branch: its numbers, the owner's safety
 * threshold, the four safe movements (each a short form in a dialog), and
 * its stock log. A count is entered as the number on the shelf; the server
 * works the difference out and refuses if the stock moved meanwhile.
 */
export default function StockLineView({
  vendorId,
  branchId,
  line,
  isOwner,
  lang,
  t,
  onChanged,
  onNotice,
  headingRef,
  backButton,
  initialForm = null,
}: {
  /** a form to open at once («+ استلام بضاعة» from the board) */
  initialForm?: Form;
  vendorId: string;
  branchId: string;
  line: StockLineDetail;
  isOwner: boolean;
  lang: Lang;
  t: (k: string) => string;
  /** reload this line, the list and the summary */
  onChanged: () => Promise<void> | void;
  onNotice: (text: string) => void;
  headingRef: React.RefObject<HTMLHeadingElement | null>;
  backButton: ReactNode;
}) {
  const onExpired = useSessionExpiredRedirect();
  const [form, setForm] = useState<Form>(initialForm);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [qty, setQty] = useState("");
  const [note, setNote] = useState("");
  const [kind, setKind] = useState<"DAMAGE" | "LOSS">("DAMAGE");
  const [shelf, setShelf] = useState("");
  /** the quantity the count started from (what the screen showed) */
  const [expected, setExpected] = useState(line.quantity);
  const [bigAsk, setBigAsk] = useState<null | { body: MovementBody; change: number }>(null);
  const [threshold, setThreshold] = useState(String(line.safety_stock_threshold));
  // the line was reloaded with other numbers (after a «recount» refusal or a
  // saved threshold): the count starts from the new quantity, the field shows
  // the saved threshold
  const [seen, setSeen] = useState({ q: line.quantity, t: line.safety_stock_threshold });
  if (seen.q !== line.quantity || seen.t !== line.safety_stock_threshold) {
    setSeen({ q: line.quantity, t: line.safety_stock_threshold });
    setExpected(line.quantity);
    setThreshold(String(line.safety_stock_threshold));
  }
  const [ledger, setLedger] = useState<LedgerEntry[] | null>(null);
  const [ledgerCursor, setLedgerCursor] = useState<string | null>(null);
  const [ledgerBusy, setLedgerBusy] = useState(false);
  const seq = useRef(0);

  const loadLedger = useCallback((): Promise<void> => {
    const n = ++seq.current;
    return fetchLedger(vendorId, branchId, line.offer_variant_id).then(
      (r) => {
        if (n !== seq.current) return;
        setLedger(r.items);
        setLedgerCursor(r.next_cursor);
      },
      (err: unknown) => {
        if (isUnauthorized(err)) onExpired();
      },
    );
  }, [vendorId, branchId, line.offer_variant_id, onExpired]);
  useEffect(() => {
    void loadLedger();
  }, [loadLedger]);

  async function moreLedger() {
    if (!ledgerCursor) return;
    setLedgerBusy(true);
    try {
      const r = await fetchLedger(vendorId, branchId, line.offer_variant_id, ledgerCursor);
      setLedger((x) => [...(x ?? []), ...r.items]);
      setLedgerCursor(r.next_cursor);
    } catch (err) {
      if (isUnauthorized(err)) onExpired();
    } finally {
      setLedgerBusy(false);
    }
  }

  function open(f: Form) {
    setForm(f);
    setError(null);
    setQty("");
    setNote("");
    setShelf("");
    setKind("DAMAGE");
    setExpected(line.quantity);
  }
  function close() {
    if (busy) return;
    setForm(null);
    setBigAsk(null);
    setError(null);
  }

  async function send(body: MovementBody, doneKey: string) {
    setBusy(true);
    setError(null);
    try {
      await postMovement(vendorId, branchId, line.offer_variant_id, body);
      setForm(null);
      setBigAsk(null);
      onNotice(t(doneKey));
      await onChanged();
      await loadLedger();
    } catch (err) {
      if (isUnauthorized(err)) return onExpired();
      const k = stockErrorKey(err);
      setBigAsk(null);
      setError(t(k));
      // the stock moved while counting: the count starts again from the new number
      if (k === "sk.err.recount") {
        setShelf("");
        await onChanged();
      }
    } finally {
      setBusy(false);
    }
  }
  /** A big change asks once more; anything else goes straight away. */
  function submit(body: MovementBody, change: number, doneKey: string) {
    if (needsSecondConfirm(change, line.quantity)) {
      setBigAsk({ body, change });
      return;
    }
    void send(body, doneKey);
  }

  const noteOk = () => {
    if (!note.trim()) {
      setError(t("sk.note_required"));
      return false;
    }
    return true;
  };

  function submitReceive() {
    const n = wholePositive(qty);
    if (!n) return setError(t("sk.qty_positive"));
    submit({ reason: "RECEIVE", quantity_delta: n, reason_note: note.trim() || t("sk.reason.RECEIVE") }, n, "sk.done.RECEIVE");
  }
  function submitOut(reason: "DAMAGE" | "LOSS" | "INTERNAL_USE") {
    const n = wholePositive(qty);
    if (!n) return setError(t("sk.qty_positive"));
    if (!noteOk()) return;
    void send({ reason, quantity_delta: -n, reason_note: note.trim() }, `sk.done.${reason}`);
  }
  async function submitCount() {
    if (!/^\d{1,6}$/.test(shelf.trim())) return setError(t("sk.qty_positive"));
    const counted = Number(shelf.trim());
    if (counted === expected) {
      // nothing to correct: the existing «confirm the count» (last count = now)
      setBusy(true);
      setError(null);
      try {
        await confirmCount(vendorId, branchId, line.offer_variant_id, note);
        setForm(null);
        onNotice(t("sk.done.count_confirmed"));
        await onChanged();
      } catch (err) {
        if (isUnauthorized(err)) return onExpired();
        setError(t(stockErrorKey(err)));
      } finally {
        setBusy(false);
      }
      return;
    }
    if (!noteOk()) return;
    submit(
      { reason: "COUNT_CORRECTION", counted_quantity: counted, expected_quantity: expected, reason_note: note.trim() },
      counted - expected,
      "sk.done.COUNT_CORRECTION",
    );
  }
  async function submitThreshold() {
    if (!/^\d{1,6}$/.test(threshold.trim())) return setError(t("sk.err.invalid"));
    setBusy(true);
    setError(null);
    try {
      await saveThreshold(vendorId, branchId, line.offer_variant_id, Number(threshold.trim()));
      onNotice(t("sk.threshold_saved"));
      await onChanged();
    } catch (err) {
      if (isUnauthorized(err)) return onExpired();
      setError(t(stockErrorKey(err)));
    } finally {
      setBusy(false);
    }
  }

  const title = lineTitle(line, lang);
  const variant = lineVariant(line, lang);
  const shelfNum = /^\d{1,6}$/.test(shelf.trim()) ? Number(shelf.trim()) : null;
  const diff = shelfNum === null ? null : shelfNum - expected;
  const signed = (n: number) => (n > 0 ? `+${n}` : String(n));
  const dialogError = form && error ? <p className="sk-error" role="alert">{error}</p> : null;
  const qtyField = (id: string) => (
    <>
      <label htmlFor={id} className="sk-label">{t("sk.qty")}</label>
      <input id={id} className="sk-input sk-input-num" inputMode="numeric" dir="ltr" value={qty} onChange={(e) => setQty(e.target.value.replace(/\D/g, "").slice(0, 6))} autoFocus data-testid="sk-qty" />
    </>
  );
  const noteField = (id: string, placeholder: string) => (
    <>
      <label htmlFor={id} className="sk-label">{t("sk.note")}</label>
      <textarea id={id} className="sk-input" rows={2} maxLength={1000} dir="auto" value={note} placeholder={placeholder} onChange={(e) => setNote(e.target.value)} data-testid="sk-note" />
    </>
  );
  return (
    <article className="sk-detail" aria-labelledby="sk-detail-title" data-testid="sk-detail" data-variant-id={line.offer_variant_id}>
      <div className="sk-detail-scroll">
        {backButton}
        <header className="sk-detail-head">
          <span className="sk-detail-img"><SafeImage src={line.image_url} alt={title} width={72} height={72} /></span>
          <div className="sk-detail-name">
            <h2 id="sk-detail-title" ref={headingRef} tabIndex={-1} className="sk-detail-title" dir="auto">{title}</h2>
            <p className="sk-muted">
              {line.color_hex && <span className="sk-swatch" style={{ background: line.color_hex }} aria-hidden="true" />}
              <span dir="auto">{variant || "—"}</span>
            </p>
            <p className="sk-muted sk-codes">
              {t("sk.barcode")}: <bdi>{line.store_barcode}</bdi> · SKU <bdi>{line.sku}</bdi>
            </p>
          </div>
          <Badges line={line} t={t} />
        </header>

        <dl className="sk-numbers" data-testid="sk-numbers">
          <div className="is-main">
            <dt>{t("sk.available")}</dt>
            <dd data-testid="sk-available">{line.available_quantity}</dd>
          </div>
          <div>
            <dt>{t("sk.reserved")}</dt>
            <dd data-testid="sk-reserved">{line.reserved_quantity}</dd>
          </div>
          <div>
            <dt>{t("sk.physical")}</dt>
            <dd data-testid="sk-physical">{line.quantity}</dd>
          </div>
          <div title={t("sk.open_orders_hint")}>
            <dt>{t("sk.open_orders")}</dt>
            <dd data-testid="sk-open-orders">{line.in_open_orders}</dd>
          </div>
          <div>
            <dt>{t("sk.counted_at")}</dt>
            <dd>
              {line.last_physical_count_at ? (
                <time dateTime={line.last_physical_count_at} title={exactTime(line.last_physical_count_at, lang)}>{relativeTime(line.last_physical_count_at, lang)}</time>
              ) : (
                t("sk.never_counted")
              )}
            </dd>
          </div>
        </dl>

        <section className="sk-sec" aria-labelledby="sk-threshold-title">
          <h3 id="sk-threshold-title" className="sk-sec-title">{t("sk.threshold")}</h3>
          {isOwner ? (
            <div className="sk-threshold">
              <label htmlFor="sk-threshold-input" className="visually-hidden">{t("sk.threshold")}</label>
              <input id="sk-threshold-input" className="sk-input sk-input-num" inputMode="numeric" dir="ltr" value={threshold} onChange={(e) => setThreshold(e.target.value.replace(/\D/g, "").slice(0, 6))} data-testid="sk-threshold" />
              <button type="button" className="sk-btn sk-btn-quiet" disabled={busy} onClick={() => void submitThreshold()} data-testid="sk-threshold-save">{t("sk.threshold_save")}</button>
            </div>
          ) : (
            <p data-testid="sk-threshold-readonly">{line.safety_stock_threshold > 0 ? line.safety_stock_threshold : t("sk.threshold_none")}</p>
          )}
          <p className="sk-muted">{line.safety_stock_threshold > 0 ? t("sk.threshold_hint") : t("sk.threshold_none")}</p>
          {!form && error && <p className="sk-error" role="alert">{error}</p>}
        </section>

        <section className="sk-sec" aria-labelledby="sk-ledger-title">
          <h3 id="sk-ledger-title" className="sk-sec-title">{t("sk.ledger")}</h3>
          {!ledger && <div className="skeleton" style={{ height: 80, width: "100%" }} />}
          {ledger && ledger.length === 0 && <p className="sk-muted">{t("sk.ledger_empty")}</p>}
          {ledger && ledger.length > 0 && (
            <ol className="sk-ledger" data-testid="sk-ledger">
              {ledger.map((m) => (
                <li key={m.id} className="sk-ledger-row" data-testid="sk-ledger-row" data-reason={m.reason}>
                  <span className={`sk-delta ${m.delta > 0 ? "is-in" : "is-out"}`} dir="ltr">{signed(m.delta)}</span>
                  <div className="sk-ledger-body">
                    <p className="sk-ledger-what">
                      <strong>{t(`sk.reason.${m.reason}`)}</strong>
                      <span className="sk-muted"> · {t("sk.ledger_after")}: <bdi>{m.resulting_quantity}</bdi></span>
                    </p>
                    <p className="sk-ledger-who">
                      <Actor m={m} t={t} />
                      {m.reference && (
                        <>
                          {" · "}
                          {m.reference.kind === "order" ? (
                            <Link href={`/vendor/${vendorId}/branches/${branchId}/orders?order=${m.reference.id}`} className="sk-link">{fillSk(t("sk.ref.order"), { n: m.reference.number })}</Link>
                          ) : m.reference.kind === "store_sale" ? (
                            <span>{fillSk(t("sk.ref.store_sale"), { n: m.reference.number })}</span>
                          ) : (
                            <span>{fillSk(t("sk.ref.return"), { n: m.reference.number })}</span>
                          )}
                        </>
                      )}
                    </p>
                    {m.note && <p className="sk-ledger-note" dir="auto">{m.note}</p>}
                    <p className="sk-muted sk-ledger-when">
                      <time dateTime={m.at} title={exactTime(m.at, lang)}>{relativeTime(m.at, lang)}</time> · {exactTime(m.at, lang)}
                    </p>
                  </div>
                </li>
              ))}
            </ol>
          )}
          {ledgerCursor && (
            <button type="button" className="sk-btn sk-btn-quiet" disabled={ledgerBusy} aria-busy={ledgerBusy} onClick={() => void moreLedger()} data-testid="sk-ledger-more">{t("sk.more")}</button>
          )}
        </section>
      </div>

      <div className="sk-actionbar" role="group" aria-label={t("sk.actions")} data-testid="sk-actionbar">
        <button type="button" className="sk-btn sk-btn-primary" onClick={() => open("receive")} data-testid="sk-action-receive">{t("sk.a.receive")}</button>
        <button type="button" className="sk-btn sk-btn-quiet" onClick={() => open("count")} data-testid="sk-action-count">{t("sk.a.count")}</button>
        <button type="button" className="sk-btn sk-btn-quiet" onClick={() => open("damage")} data-testid="sk-action-damage">{t("sk.a.damage")}</button>
        <button type="button" className="sk-btn sk-btn-quiet" onClick={() => open("internal")} data-testid="sk-action-internal">{t("sk.a.internal")}</button>
      </div>

      {form === "receive" && !bigAsk && (
        <StockModal title={`${t("sk.receive.title")} - ${title}`} busy={busy} onClose={close} testId="sk-form-receive">
          <p className="sk-muted" dir="auto">{variant}</p>
          {qtyField("sk-receive-qty")}
          {noteField("sk-receive-note", t("sk.receive.note_placeholder"))}
          {dialogError}
          <DialogButtons onOk={submitReceive} busy={busy} onClose={close} t={t} />
        </StockModal>
      )}
      {form === "count" && !bigAsk && (
        <StockModal title={`${t("sk.count.title")} - ${title}`} busy={busy} onClose={close} testId="sk-form-count">
          <p className="sk-muted" dir="auto">{variant}</p>
          <p className="sk-count-line" data-testid="sk-count-system">{fillSk(t("sk.count.system"), { x: expected })}</p>
          <label htmlFor="sk-count-shelf" className="sk-label">{t("sk.count.shelf")}</label>
          <input id="sk-count-shelf" className="sk-input sk-input-num" inputMode="numeric" dir="ltr" value={shelf} onChange={(e) => setShelf(e.target.value.replace(/\D/g, "").slice(0, 6))} autoFocus data-testid="sk-count-shelf" />
          {diff !== null && (
            <p className={`sk-count-diff${diff === 0 ? "" : diff > 0 ? " is-in" : " is-out"}`} role="status" data-testid="sk-count-diff">
              {diff === 0 ? t("sk.count.same") : fillSk(t("sk.count.diff"), { y: signed(diff) })}
            </p>
          )}
          {noteField("sk-count-note", t("sk.count.note_placeholder"))}
          {dialogError}
          <DialogButtons onOk={() => void submitCount()} busy={busy} onClose={close} t={t} />
        </StockModal>
      )}
      {form === "damage" && !bigAsk && (
        <StockModal title={`${t("sk.damage.title")} - ${title}`} busy={busy} onClose={close} testId="sk-form-damage">
          <fieldset className="sk-kind">
            <legend className="sk-label">{t("sk.damage.kind")}</legend>
            {(["DAMAGE", "LOSS"] as const).map((k) => (
              <label key={k} className="sk-radio">
                <input type="radio" name="sk-damage-kind" checked={kind === k} onChange={() => setKind(k)} data-testid={`sk-kind-${k}`} />
                {t(`sk.reason.${k}`)}
              </label>
            ))}
          </fieldset>
          {qtyField("sk-damage-qty")}
          {noteField("sk-damage-note", t("sk.damage.note_placeholder"))}
          {dialogError}
          <DialogButtons onOk={() => submitOut(kind)} busy={busy} onClose={close} t={t} danger />
        </StockModal>
      )}
      {form === "internal" && !bigAsk && (
        <StockModal title={`${t("sk.internal.title")} - ${title}`} busy={busy} onClose={close} testId="sk-form-internal">
          <p>{t("sk.internal.lead")}</p>
          <p className="sk-muted">{t("sk.internal.transfer")}</p>
          {qtyField("sk-internal-qty")}
          {noteField("sk-internal-note", t("sk.internal.note_placeholder"))}
          {dialogError}
          <DialogButtons onOk={() => submitOut("INTERNAL_USE")} busy={busy} onClose={close} t={t} danger />
        </StockModal>
      )}
      {bigAsk && (
        <StockModal title={t("sk.big.title")} busy={busy} onClose={() => setBigAsk(null)} testId="sk-big-confirm">
          <p>{fillSk(t("sk.big.lead"), { n: Math.abs(bigAsk.change), x: line.quantity })}</p>
          {error && <p className="sk-error" role="alert">{error}</p>}
          <div className="sk-row sk-dialog-actions">
            <button type="button" className="sk-btn sk-btn-primary" disabled={busy} aria-busy={busy} onClick={() => void send(bigAsk.body, bigAsk.body.reason === "RECEIVE" ? "sk.done.RECEIVE" : "sk.done.COUNT_CORRECTION")} data-testid="sk-big-yes">
              {t("sk.big.yes")}
            </button>
            <button type="button" className="sk-btn sk-btn-quiet" disabled={busy} onClick={() => setBigAsk(null)}>{t("sk.close")}</button>
          </div>
        </StockModal>
      )}
    </article>
  );
}

function DialogButtons({ onOk, busy, onClose, t, danger = false }: { onOk: () => void; busy: boolean; onClose: () => void; t: (k: string) => string; danger?: boolean }) {
  return (
    <div className="sk-row sk-dialog-actions">
      <button type="button" className={`sk-btn ${danger ? "sk-btn-danger" : "sk-btn-primary"}`} disabled={busy} aria-busy={busy} onClick={onOk} data-testid="sk-submit">
        {t("sk.save")}
      </button>
      <button type="button" className="sk-btn sk-btn-quiet" disabled={busy} onClick={onClose}>{t("sk.close")}</button>
    </div>
  );
}

export function Badges({ line, t }: { line: { is_low: boolean; is_out: boolean; is_stale: boolean }; t: (k: string) => string }) {
  return (
    <span className="sk-badges">
      {line.is_out && <span className="sk-badge is-out" data-testid="sk-badge-out">{t("sk.badge.out")}</span>}
      {line.is_low && <span className="sk-badge is-low" data-testid="sk-badge-low">{t("sk.badge.low")}</span>}
      {line.is_stale && <span className="sk-badge is-stale">{t("sk.badge.stale")}</span>}
    </span>
  );
}

function Actor({ m, t }: { m: LedgerEntry; t: (k: string) => string }) {
  if (m.actor.kind === "system") return <span>{t("sk.actor.system")}</span>;
  if (m.actor.kind === "customer") return <span>{t("sk.actor.customer")}</span>;
  const role = m.actor.role ? t(`sk.actor.${m.actor.role}`) : null;
  return <span dir="auto">{[m.actor.name, role].filter(Boolean).join(" · ") || "—"}</span>;
}
