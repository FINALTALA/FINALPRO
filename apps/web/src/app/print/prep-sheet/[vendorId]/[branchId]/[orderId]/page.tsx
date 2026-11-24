"use client";

import { useParams, useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { ApiError } from "@/lib/api";
import { isUnauthorized } from "@/lib/apiErrors";
import { clock, dayLabel, exactTime, fetchPrepSheet, statusKey, type PrepSheet } from "@/lib/branchOrders";
import { fillBo } from "@/lib/branchOrdersText";
import { useLang, useT } from "@/lib/useLang";
import { useSessionExpiredRedirect } from "@/lib/useSessionExpiredRedirect";
import "./prepSheet.css";

/**
 * «إدارة طلبات الفرع v2» phase 1 (2026-11-24): the internal prep sheet of ONE
 * order, for the owner or the branch's employee - a clean page with no store
 * header (AppShell renders /print/* bare) and two screen-only controls
 * («رجوع إلى الطلب», «طباعة»). It shows what the server sends and nothing
 * else: the order number, branch, fulfilment, the pieces (colour, size,
 * quantity) and the notes. Never a pickup code, a price, the shopper's name,
 * phone or address - the server's answer holds none of them. Not a receipt.
 * Opened in the same tab: the store workspace lives in this tab only.
 */
export default function PrepSheetPage() {
  const { vendorId, branchId, orderId } = useParams<{ vendorId: string; branchId: string; orderId: string }>();
  const t = useT();
  const lang = useLang();
  const router = useRouter();
  const onExpired = useSessionExpiredRedirect();
  const [sheet, setSheet] = useState<PrepSheet | null>(null);
  /** a translation key, translated when shown (`t` is a new function on every render) */
  const [error, setError] = useState<string | null>(null);
  const [printedAt, setPrintedAt] = useState<string | null>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);

  useEffect(() => {
    let live = true;
    fetchPrepSheet(vendorId, branchId, orderId).then(
      (s) => {
        if (!live) return;
        setSheet(s);
        setPrintedAt(new Date().toISOString());
      },
      (err: unknown) => {
        if (!live) return;
        if (isUnauthorized(err)) return onExpired();
        if (err instanceof ApiError && err.status === 409) setError("bo.prep.unavailable");
        else if (err instanceof ApiError && err.status === 404) setError("bo.prep.not_found");
        else if (err instanceof ApiError && err.status === 403) setError("bo.prep.forbidden");
        else setError("bo.prep.error");
      },
    );
    return () => {
      live = false;
    };
  }, [vendorId, branchId, orderId, onExpired]);

  useEffect(() => {
    if (sheet) headingRef.current?.focus();
  }, [sheet]);

  const boardHref = `/vendor/${encodeURIComponent(vendorId)}/branches/${encodeURIComponent(branchId)}/orders?order=${encodeURIComponent(orderId)}`;
  function back() {
    // the order this sheet came from (same tab); a sheet opened directly goes to the order
    if (window.history.length > 1) router.back();
    else router.replace(boardHref);
  }

  const slot = sheet?.scheduled_date && sheet.window
    ? `${dayLabel(sheet.scheduled_date, lang)} · ${clock(sheet.window.start_minute, lang)}–${clock(sheet.window.end_minute, lang)}`
    : null;

  return (
    <div className="ps-page" data-testid="prep-sheet-page">
      <div className="ps-toolbar" role="group" aria-label={t("bo.prep.title")}>
        <button type="button" className="ps-btn ps-btn-quiet" onClick={back} data-testid="prep-sheet-back">
          <span aria-hidden="true" className="ps-back-arrow">‹</span> {t("bo.prep.back")}
        </button>
        {sheet && (
          <button type="button" className="ps-btn ps-btn-primary" onClick={() => window.print()} data-testid="prep-sheet-print">
            {t("bo.prep.print_btn")}
          </button>
        )}
      </div>

      {!sheet && !error && <div className="skeleton ps-skeleton" aria-busy="true" />}
      {error && (
        <p className="ps-error" role="alert" data-testid="prep-sheet-error">
          {t(error)}
        </p>
      )}

      {sheet && (
        <article className="ps-sheet" aria-labelledby="ps-title" data-testid="prep-sheet">
          <header className="ps-head">
            <p className="ps-kind">{t("bo.prep.title")}</p>
            <h1 id="ps-title" ref={headingRef} tabIndex={-1} className="ps-title">
              {fillBo(t("bo.order_n"), { n: sheet.number })}
            </h1>
            <p className="ps-internal">{t("bo.prep.internal")}</p>
          </header>

          <dl className="ps-facts">
            <div>
              <dt>{t("bo.prep.branch")}</dt>
              <dd dir="auto" data-testid="prep-sheet-branch">{sheet.branch_name}</dd>
            </div>
            <div>
              <dt>{t("bo.prep.method")}</dt>
              <dd data-testid="prep-sheet-method">{t(`bo.method.${sheet.fulfilment_method}`)}</dd>
            </div>
            {slot && (
              <div>
                <dt>{t("bo.prep.slot")}</dt>
                <dd>{slot}</dd>
              </div>
            )}
            <div>
              <dt>{t("bo.prep.created")}</dt>
              <dd>
                <time dateTime={sheet.created_at}>{exactTime(sheet.created_at, lang)}</time>
              </dd>
            </div>
            <div>
              <dt>{t("bo.prep.status")}</dt>
              <dd>{t(statusKey(sheet.status))}</dd>
            </div>
          </dl>

          <section aria-labelledby="ps-items">
            <h2 id="ps-items" className="ps-sec-title">
              {t("bo.prep.items")}
            </h2>
            <table className="ps-table" data-testid="prep-sheet-items">
              <thead>
                <tr>
                  <th scope="col">{t("bo.prep.col.item")}</th>
                  <th scope="col">{t("bo.prep.col.color")}</th>
                  <th scope="col">{t("bo.prep.col.size")}</th>
                  <th scope="col" className="ps-num">{t("bo.prep.col.qty")}</th>
                </tr>
              </thead>
              <tbody>
                {sheet.items.map((i) => {
                  const title = lang === "en" && i.title_en ? i.title_en : i.title_ar;
                  const colour = lang === "en" ? (i.color_name_en ?? i.color_name_ar) : (i.color_name_ar ?? i.color_name_en);
                  return (
                    <tr key={i.id} data-testid="prep-sheet-item">
                      <td dir="auto">{title}</td>
                      <td dir="auto">{colour ?? "—"}</td>
                      <td>
                        <bdi>{i.size_label ?? "—"}</bdi>
                      </td>
                      <td className="ps-num ps-qty">{i.quantity}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            <p className="ps-total" data-testid="prep-sheet-total">{fillBo(t("bo.prep.total"), { n: sheet.item_count })}</p>
          </section>

          <section aria-labelledby="ps-notes" className="ps-notes">
            <h2 id="ps-notes" className="visually-hidden">{t("bo.sec.notes")}</h2>
            <div className="ps-note">
              <h3 className="ps-note-title">{t("bo.prep.customer_note")}</h3>
              <p dir="auto" data-testid="prep-sheet-customer-note">{sheet.customer_note || <span className="ps-muted">{t("bo.no_note")}</span>}</p>
            </div>
            {sheet.internal_store_note && (
              <div className="ps-note">
                <h3 className="ps-note-title">{t("bo.prep.internal_note")}</h3>
                <p dir="auto" data-testid="prep-sheet-internal-note">{sheet.internal_store_note}</p>
              </div>
            )}
          </section>

          {printedAt && <p className="ps-foot">{fillBo(t("bo.prep.printed"), { t: exactTime(printedAt, lang) })}</p>}
        </article>
      )}
    </div>
  );
}
