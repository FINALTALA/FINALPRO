"use client";

import "@/lib/adminOrdersText";
import Link from "next/link";
import { useParams } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { SmallConfirm } from "@/components/owner/collections/SmallConfirm";
import { EmptyState, ErrorBanner } from "@/components/States";
import { apiFetch, ApiError, newIdempotencyKey } from "@/lib/api";
import { fill, formatMoney, statusTone } from "@/lib/adminOrdersText";
import { apiErrorMessage } from "@/lib/apiErrors";
import { useAdminGate } from "@/lib/useAdminGate";
import { useLang, useT } from "@/lib/useLang";
import styles from "../../approvals/approvals.module.css";

// VIA phase 2D - one branch order, read-only: the checkout snapshot lines,
// money, dates, refunds, returns, the customer order it belongs to and its
// history. The one action is the EXISTING forced cancel
// (POST /admin/branch-orders/:id/cancel), offered only where its own rule
// allows it; escalated returns link to their existing decision page.

interface Detail {
  id: string;
  number: string;
  status: string;
  fulfilment_method: string;
  payment_method: string;
  store: { id: string; name: string; slug: string };
  branch: { id: string; name: string };
  customer: { display_name: string | null; phone_masked: string | null };
  delivery: {
    zone: string | null;
    address_label: string | null;
    scheduled_date: string | null;
    window: { start_minute: number; end_minute: number } | null;
    attempts: number;
  } | null;
  money: {
    subtotal: number | null;
    delivery_fee: number | null;
    total: number | null;
    amount_due: number;
    refunded: number;
    remaining_refundable: number;
    cod_collected: number | null;
    cod_collected_at: string | null;
  };
  payment: { status: string; amount: number | null; at: string } | null;
  dates: Record<string, string | null>;
  cancellation_reason: string | null;
  customer_note: string | null;
  items: {
    id: string;
    title_ar: string | null;
    title_en: string | null;
    colour: string | null;
    colour_en: string | null;
    colour_hex: string | null;
    size: string | null;
    quantity: number;
    unit_price: number | null;
    line_total: number;
    cancelled_at: string | null;
    cancelled_reason: string | null;
    refunded: boolean;
    returns: {
      id: string;
      status: string;
      outcome: string;
      reason: string;
      created_at: string;
      escalated: boolean;
    }[];
  }[];
  refunds: {
    id: string;
    amount: number | null;
    reason: string;
    initiated_by: string;
    method: string;
    item_id: string | null;
    created_at: string;
  }[];
  customer_order: {
    id: string;
    created_at: string;
    branch_orders: {
      id: string;
      number: string;
      status: string;
      total: number | null;
      store_name: string;
      branch_name: string;
      current: boolean;
    }[];
  };
  timeline: {
    id: string;
    at: string;
    action: string;
    from_status: string | null;
    to_status: string | null;
    actor: string;
  }[];
  actions: {
    force_cancel: boolean;
    own_order: boolean;
    escalated_returns: boolean;
  };
}

const DATE_KEYS = [
  "created_at",
  "preparation_started_at",
  "ready_at",
  "picked_up_at",
  "delivered_at",
  "delivery_failed_at",
  "not_received_reported_at",
  "completed_at",
] as const;

export default function AdminOrderDetailPage() {
  const gate = useAdminGate("ADMIN");
  const t = useT();
  const lang = useLang();
  const { orderId } = useParams<{ orderId: string }>();
  const [detail, setDetail] = useState<Detail | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [missing, setMissing] = useState(false);
  const [reason, setReason] = useState("");
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);

  const fetchDetail = useCallback(
    () => apiFetch<Detail>(`/admin/orders/${orderId}`),
    [orderId],
  );

  useEffect(() => {
    if (gate.status !== "ok") return;
    let cancelled = false;
    fetchDetail()
      .then((d) => {
        if (!cancelled) setDetail(d);
      })
      .catch((err) => {
        if (cancelled) return;
        if (err instanceof ApiError && err.status === 404) setMissing(true);
        else setError(err);
      });
    return () => {
      cancelled = true;
    };
  }, [gate.status, fetchDetail, attempt]);

  async function forceCancel() {
    setBusy(true);
    setActionError(null);
    try {
      const r = await apiFetch<{ refunded_amount: number }>(
        `/admin/branch-orders/${orderId}/cancel`,
        {
          method: "POST",
          body: { reason: reason.trim() },
          idempotencyKey: newIdempotencyKey("admin-order-cancel"),
        },
      );
      setNotice(
        fill(t("ao.cancelled_notice"), {
          amount: formatMoney(r.refunded_amount, lang),
        }),
      );
      setReason("");
      setConfirming(false);
      setDetail(await fetchDetail());
    } catch (err) {
      setActionError(apiErrorMessage(err, lang));
      setConfirming(false);
    } finally {
      setBusy(false);
    }
  }

  if (gate.status === "loading") {
    return (
      <div className="page-shell">
        <div
          className="skeleton"
          style={{ height: 200, width: "100%", maxWidth: 1100 }}
        />
      </div>
    );
  }
  if (gate.status === "forbidden") {
    return (
      <div className="page-shell">
        <EmptyState
          title={t("ao.forbidden")}
          actionHref="/account"
          actionLabel={t("ao.account")}
        />
      </div>
    );
  }

  const time = (iso: string | null) =>
    iso
      ? new Date(iso).toLocaleString(lang === "ar" ? "ar" : "en-GB", {
          dateStyle: "medium",
          timeStyle: "short",
        })
      : "-";
  const minutes = (m: number) =>
    `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
  const title = (i: Detail["items"][number]) =>
    (lang === "en" && i.title_en ? i.title_en : i.title_ar) ?? "-";
  const allReturns =
    detail?.items.flatMap((i) =>
      i.returns.map((r) => ({ ...r, item: title(i) })),
    ) ?? [];
  const reasonOk = reason.trim().length >= 10;

  return (
    <div className="page-shell">
      <div className="wide-shell" style={{ maxWidth: 1100 }}>
        <p style={{ margin: "0 0 8px" }}>
          <Link href="/admin/orders" className="button-link">
            {t("ao.back")}
          </Link>
        </p>
        {missing && (
          <EmptyState
            title={t("ao.not_found")}
            actionHref="/admin/orders"
            actionLabel={t("ao.back")}
          />
        )}
        {error !== null && (
          <div className={styles.unavailable} role="alert">
            <span>
              {t("ao.load_failed")} {apiErrorMessage(error, lang)}
            </span>
            <button
              type="button"
              className="button"
              onClick={() => {
                setError(null);
                setAttempt((a) => a + 1);
              }}
            >
              {t("ao.retry")}
            </button>
          </div>
        )}
        {!detail && !missing && error === null && (
          <div
            className="skeleton"
            aria-busy="true"
            style={{ height: 240, width: "100%" }}
          />
        )}

        {detail && (
          <div style={{ display: "grid", gap: 16 }}>
            <div className="top-bar" style={{ flexWrap: "wrap", gap: 8 }}>
              <h1 className="page-title" style={{ margin: 0 }}>
                <bdi>{fill(t("ao.d.title"), { n: detail.number })}</bdi>
              </h1>
              <span
                className="badge"
                style={statusTone(detail.status)}
                data-testid="ao-status"
              >
                {t(`ao.status.${detail.status}`)}
              </span>
            </div>
            {notice && (
              <p className="notice" role="status" data-testid="ao-notice">
                {notice}
              </p>
            )}

            <section className={styles.panel}>
              <h2 className={styles.panelTitle}>{t("ao.d.summary")}</h2>
              <dl className={styles.brandFacts}>
                <div>
                  <dt>{t("ao.d.store")}</dt>
                  <dd>
                    <Link href={`/admin/vendors/${detail.store.id}`}>
                      {detail.store.name}
                    </Link>
                  </dd>
                </div>
                <div>
                  <dt>{t("ao.d.branch")}</dt>
                  <dd>{detail.branch.name}</dd>
                </div>
                <div>
                  <dt>{t("ao.d.fulfilment")}</dt>
                  <dd>{t(`ao.fulfilment.${detail.fulfilment_method}`)}</dd>
                </div>
                <div>
                  <dt>{t("ao.d.payment")}</dt>
                  <dd>{t(`ao.payment.${detail.payment_method}`)}</dd>
                </div>
                <div>
                  <dt>{t("ao.d.customer")}</dt>
                  <dd data-testid="ao-customer">
                    {detail.customer.display_name ?? t("ao.d.no_name")}
                    {detail.customer.phone_masked && (
                      <>
                        {" · "}
                        <bdi title={t("ao.d.customer_hidden")}>
                          {detail.customer.phone_masked}
                        </bdi>
                      </>
                    )}
                  </dd>
                </div>
                {detail.delivery && (
                  <>
                    <div>
                      <dt>{t("ao.d.zone")}</dt>
                      <dd>
                        {[detail.delivery.zone, detail.delivery.address_label]
                          .filter(Boolean)
                          .join(" · ") || "-"}
                      </dd>
                    </div>
                    <div>
                      <dt>{t("ao.d.scheduled")}</dt>
                      <dd>
                        <bdi>
                          {detail.delivery.scheduled_date ?? "-"}
                          {detail.delivery.window &&
                            ` ${minutes(detail.delivery.window.start_minute)}–${minutes(detail.delivery.window.end_minute)}`}
                        </bdi>
                      </dd>
                    </div>
                    <div>
                      <dt>{t("ao.d.attempts")}</dt>
                      <dd>{detail.delivery.attempts}</dd>
                    </div>
                  </>
                )}
                {detail.cancellation_reason && (
                  <div>
                    <dt>{t("ao.d.cancellation_reason")}</dt>
                    <dd>{detail.cancellation_reason}</dd>
                  </div>
                )}
                {detail.customer_note && (
                  <div>
                    <dt>{t("ao.d.customer_note")}</dt>
                    <dd>{detail.customer_note}</dd>
                  </div>
                )}
              </dl>
            </section>

            <section className={styles.panel}>
              <h2 className={styles.panelTitle}>{t("ao.d.lines")}</h2>
              <ol className={styles.list} data-testid="ao-lines">
                {detail.items.map((i) => (
                  <li
                    key={i.id}
                    className={styles.row}
                    style={{ gridTemplateColumns: "minmax(0,1fr) auto" }}
                    data-testid="ao-line"
                  >
                    <div className={styles.rowMain}>
                      <strong className={styles.rowPrimary}>{title(i)}</strong>
                      <span className={styles.rowSecondary}>
                        {i.colour && (
                          <>
                            {t("ao.d.colour")}:{" "}
                            {lang === "en"
                              ? (i.colour_en ?? i.colour)
                              : i.colour}
                            {i.colour_hex && (
                              <span
                                aria-hidden="true"
                                style={{
                                  display: "inline-block",
                                  width: 10,
                                  height: 10,
                                  borderRadius: 5,
                                  background: i.colour_hex,
                                  border: "1px solid var(--color-border)",
                                  marginInline: 4,
                                }}
                              />
                            )}
                            {" · "}
                          </>
                        )}
                        {i.size && (
                          <>
                            {t("ao.d.size")}: <bdi>{i.size}</bdi> ·{" "}
                          </>
                        )}
                        <bdi>
                          {fill(t("ao.d.qty"), {
                            n: i.quantity,
                            price: formatMoney(i.unit_price, lang),
                          })}
                        </bdi>
                      </span>
                      {(i.cancelled_at || i.refunded) && (
                        <span
                          style={{ display: "flex", gap: 4, flexWrap: "wrap" }}
                        >
                          {i.cancelled_at && (
                            <span
                              className="badge"
                              style={statusTone("CANCELLED")}
                              title={i.cancelled_reason ?? undefined}
                            >
                              {t("ao.d.line_cancelled")}
                            </span>
                          )}
                          {i.refunded && (
                            <span className="badge">
                              {t("ao.d.line_refunded")}
                            </span>
                          )}
                        </span>
                      )}
                    </div>
                    <strong>
                      <bdi>{formatMoney(i.line_total, lang)}</bdi>
                    </strong>
                  </li>
                ))}
              </ol>
            </section>

            <div
              style={{
                display: "grid",
                gap: 16,
                gridTemplateColumns:
                  "repeat(auto-fit, minmax(min(100%, 320px), 1fr))",
              }}
            >
              <section className={styles.panel}>
                <h2 className={styles.panelTitle}>{t("ao.d.money")}</h2>
                <dl className={styles.brandFacts} data-testid="ao-money">
                  {(
                    [
                      ["subtotal", detail.money.subtotal],
                      ["delivery_fee", detail.money.delivery_fee],
                      ["total", detail.money.total],
                      ["amount_due", detail.money.amount_due],
                      ["refunded", detail.money.refunded],
                      ["remaining", detail.money.remaining_refundable],
                    ] as const
                  ).map(([k, v]) => (
                    <div key={k}>
                      <dt>{t(`ao.d.${k}`)}</dt>
                      <dd>
                        <bdi>{formatMoney(v, lang)}</bdi>
                      </dd>
                    </div>
                  ))}
                  {detail.money.cod_collected !== null && (
                    <div>
                      <dt>{t("ao.d.cod_collected")}</dt>
                      <dd>
                        <bdi>
                          {formatMoney(detail.money.cod_collected, lang)}
                        </bdi>{" "}
                        · {time(detail.money.cod_collected_at)}
                      </dd>
                    </div>
                  )}
                  {detail.payment && (
                    <div>
                      <dt>{t("ao.d.payment_tx")}</dt>
                      <dd>
                        {t(`ao.ptx.${detail.payment.status}`)} ·{" "}
                        <bdi>{formatMoney(detail.payment.amount, lang)}</bdi>
                      </dd>
                    </div>
                  )}
                </dl>
              </section>

              <section className={styles.panel}>
                <h2 className={styles.panelTitle}>{t("ao.d.dates")}</h2>
                <dl className={styles.brandFacts}>
                  {DATE_KEYS.filter((k) => detail.dates[k]).map((k) => (
                    <div key={k}>
                      <dt>{t(`ao.d.date.${k}`)}</dt>
                      <dd>{time(detail.dates[k])}</dd>
                    </div>
                  ))}
                </dl>
              </section>
            </div>

            <section className={styles.panel}>
              <h2 className={styles.panelTitle}>{t("ao.d.refunds")}</h2>
              {detail.refunds.length === 0 ? (
                <p className={styles.empty}>{t("ao.d.no_refunds")}</p>
              ) : (
                <ol className={styles.list} data-testid="ao-refunds">
                  {detail.refunds.map((r) => (
                    <li
                      key={r.id}
                      className={styles.row}
                      style={{ gridTemplateColumns: "minmax(0,1fr) auto" }}
                    >
                      <div className={styles.rowMain}>
                        <strong className={styles.rowPrimary}>
                          {t(`ao.refund.${r.reason}`)}
                        </strong>
                        <span className={styles.rowSecondary}>
                          {t(`ao.by.${r.initiated_by}`)} ·{" "}
                          {t(`ao.method.${r.method}`)} · {time(r.created_at)}
                        </span>
                      </div>
                      <strong>
                        <bdi>{formatMoney(r.amount, lang)}</bdi>
                      </strong>
                    </li>
                  ))}
                </ol>
              )}
            </section>

            <section className={styles.panel}>
              <h2 className={styles.panelTitle}>{t("ao.d.returns")}</h2>
              {allReturns.length === 0 ? (
                <p className={styles.empty}>{t("ao.d.no_returns")}</p>
              ) : (
                <ol className={styles.list} data-testid="ao-returns">
                  {allReturns.map((r) => (
                    <li
                      key={r.id}
                      className={styles.row}
                      style={{ gridTemplateColumns: "minmax(0,1fr) auto" }}
                    >
                      <div className={styles.rowMain}>
                        <strong className={styles.rowPrimary}>
                          {t(`ao.d.outcome.${r.outcome}`)} · {r.item}
                        </strong>
                        <span className={styles.rowSecondary}>
                          {t(`ret.reason.${r.reason}`)} · {time(r.created_at)}
                        </span>
                      </div>
                      <span
                        className="badge"
                        style={
                          r.escalated ? statusTone("CANCELLED") : undefined
                        }
                      >
                        {t(`ret.status.${r.status}`)}
                      </span>
                    </li>
                  ))}
                </ol>
              )}
              {detail.actions.escalated_returns && (
                <p style={{ margin: "10px 0 0" }}>
                  <Link
                    href="/admin/returns"
                    className="button-link"
                    data-testid="ao-escalated-link"
                  >
                    {t("ao.d.escalated_link")}
                  </Link>
                </p>
              )}
            </section>

            <section className={styles.panel}>
              <h2 className={styles.panelTitle}>{t("ao.d.customer_order")}</h2>
              <p className={styles.lead} style={{ marginTop: 0 }}>
                {t("ao.d.customer_order_lead")}{" "}
                <bdi>#{detail.customer_order.id.slice(0, 8).toUpperCase()}</bdi>{" "}
                · {time(detail.customer_order.created_at)}
              </p>
              <ol className={styles.list} data-testid="ao-siblings">
                {detail.customer_order.branch_orders.map((b) => (
                  <li
                    key={b.id}
                    className={styles.row}
                    style={{ gridTemplateColumns: "minmax(0,1fr) auto auto" }}
                  >
                    <div className={styles.rowMain}>
                      <strong className={styles.rowPrimary}>
                        {b.current ? (
                          <bdi>#{b.number}</bdi>
                        ) : (
                          <Link href={`/admin/orders/${b.id}`}>
                            <bdi>#{b.number}</bdi>
                          </Link>
                        )}
                        {b.current && (
                          <span
                            className="badge"
                            style={{ marginInlineStart: 6 }}
                          >
                            {t("ao.d.this_one")}
                          </span>
                        )}
                      </strong>
                      <span className={styles.rowSecondary}>
                        {b.store_name} · {b.branch_name}
                      </span>
                    </div>
                    <span className="badge" style={statusTone(b.status)}>
                      {t(`ao.status.${b.status}`)}
                    </span>
                    <bdi>{formatMoney(b.total, lang)}</bdi>
                  </li>
                ))}
              </ol>
            </section>

            <section className={styles.panel}>
              <h2 className={styles.panelTitle}>{t("ao.d.actions")}</h2>
              <p className={styles.lead} style={{ marginTop: 0 }}>
                {t("ao.d.force_cancel_lead")}
              </p>
              {actionError && <ErrorBanner message={actionError} />}
              {detail.actions.own_order ? (
                <p className={styles.empty}>{t("ao.d.own_order")}</p>
              ) : detail.actions.force_cancel ? (
                <>
                  <div className="field">
                    <label htmlFor="ao-reason">
                      {t("ao.d.force_cancel_reason")}
                    </label>
                    <textarea
                      id="ao-reason"
                      rows={2}
                      value={reason}
                      maxLength={1000}
                      onChange={(e) => setReason(e.target.value)}
                    />
                  </div>
                  <div className={styles.brandActions}>
                    <button
                      type="button"
                      className="button"
                      disabled={!reasonOk || busy}
                      onClick={() => setConfirming(true)}
                      data-testid="ao-force-cancel"
                    >
                      {t("ao.d.force_cancel")}
                    </button>
                  </div>
                </>
              ) : (
                <p className={styles.empty} data-testid="ao-no-action">
                  {t("ao.d.force_cancel_unavailable")}
                </p>
              )}
            </section>

            <section className={styles.panel}>
              <h2 className={styles.panelTitle}>{t("ao.d.timeline")}</h2>
              {detail.timeline.length === 0 ? (
                <p className={styles.empty}>{t("ao.d.no_timeline")}</p>
              ) : (
                <ol className={styles.list} data-testid="ao-timeline">
                  {detail.timeline.map((e) => (
                    <li
                      key={e.id}
                      className={styles.row}
                      style={{ gridTemplateColumns: "minmax(0,1fr) auto" }}
                    >
                      <div className={styles.rowMain}>
                        <strong className={styles.rowPrimary}>
                          {e.to_status ? (
                            <>
                              {e.from_status
                                ? `${t(`ao.status.${e.from_status}`)} → `
                                : ""}
                              {t(`ao.status.${e.to_status}`)}
                            </>
                          ) : (
                            <bdi dir="ltr">{e.action}</bdi>
                          )}
                        </strong>
                        <span className={styles.rowSecondary}>
                          {t(`ao.actor.${e.actor}`)}
                        </span>
                      </div>
                      <span className={styles.rowSecondary}>{time(e.at)}</span>
                    </li>
                  ))}
                </ol>
              )}
            </section>
          </div>
        )}
      </div>

      {confirming && detail && (
        <SmallConfirm
          title={t("ao.confirm.title")}
          lead={fill(t("ao.confirm.lead"), { n: detail.number })}
          confirmLabel={t("ao.confirm.ok")}
          cancelLabel={t("ao.confirm.cancel")}
          busy={busy}
          tone="danger"
          onConfirm={() => void forceCancel()}
          onCancel={() => setConfirming(false)}
        />
      )}
    </div>
  );
}
