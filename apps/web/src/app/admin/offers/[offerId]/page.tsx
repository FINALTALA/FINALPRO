"use client";

import "@/lib/offerModerationText";
import Link from "next/link";
import { useParams } from "next/navigation";
import { useEffect, useState } from "react";
import { SmallConfirm } from "@/components/owner/collections/SmallConfirm";
import { EmptyState, ErrorBanner } from "@/components/States";
import { apiFetch, ApiError, newIdempotencyKey } from "@/lib/api";
import { apiErrorMessage } from "@/lib/apiErrors";
import { fill } from "@/lib/offerModerationText";
import { useAdminGate } from "@/lib/useAdminGate";
import { useLang, useT } from "@/lib/useLang";
import styles from "../../approvals/approvals.module.css";

// VIA phase 2C - one offer's platform moderation: its facts, the open hold
// (if any), the store's correction and the history; Hide / Request changes
// / Return correction / Restore, each behind a confirmation. Restore sends
// the content revision shown here - a later change by the store is refused
// by the API until reviewed (reload).

interface Hold {
  id: string;
  action: "HIDE" | "REQUEST_CHANGES";
  reason: string;
  placed_at: string;
  open: boolean;
  correction: { revision: number; note: string | null; submitted_at: string; stale: boolean } | null;
  last_return: { note: string; returned_at: string } | null;
  released: { released_at: string; note: string; revision: number | null } | null;
}
interface Detail {
  id: string;
  title_ar: string;
  title_en: string;
  status: string;
  content_revision: number;
  created_at: string;
  store: { id: string; name: string; slug: string; status: string; storefront_published: boolean };
  variants: { id: string; sku: string; base_price: number; colour: string | null; size: string | null; image_url: string | null }[];
  publicly_visible: boolean;
  hold: Hold | null;
  history: Hold[];
}

type Pending = { kind: "HIDE" | "REQUEST_CHANGES" | "return" | "restore" } | null;

export default function AdminOfferDetailPage() {
  const gate = useAdminGate("ADMIN");
  const t = useT();
  const lang = useLang();
  const params = useParams<{ offerId: string }>();
  const [detail, setDetail] = useState<Detail | null>(null);
  const [loadError, setLoadError] = useState<unknown>(null);
  const [nonce, setNonce] = useState(0);
  const [reason, setReason] = useState("");
  const [note, setNote] = useState("");
  const [pending, setPending] = useState<Pending>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    if (gate.status !== "ok") return;
    let cancelled = false;
    apiFetch<Detail>(`/admin/offers/${params.offerId}`)
      .then((d) => {
        if (cancelled) return;
        setDetail(d);
        setLoadError(null);
      })
      .catch((err) => {
        if (!cancelled) setLoadError(err);
      });
    return () => {
      cancelled = true;
    };
  }, [gate.status, params.offerId, nonce]);

  const time = (iso: string) =>
    new Date(iso).toLocaleString(lang === "ar" ? "ar" : "en-GB", { dateStyle: "medium", timeStyle: "short" });

  async function run() {
    if (!pending || !detail) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    const base = `/admin/offers/${detail.id}/hold`;
    try {
      if (pending.kind === "HIDE" || pending.kind === "REQUEST_CHANGES") {
        const r = await apiFetch<{ released_reservations: number }>(base, {
          method: "POST",
          body: { action: pending.kind, reason: reason.trim() },
          idempotencyKey: newIdempotencyKey("offer-hold"),
        });
        setNotice(fill(t(pending.kind === "HIDE" ? "om.done.hide" : "om.done.request"), { n: r.released_reservations }));
        setReason("");
      } else if (pending.kind === "return") {
        await apiFetch(`${base}/return-correction`, {
          method: "POST",
          body: { note: note.trim() },
          idempotencyKey: newIdempotencyKey("offer-hold-return"),
        });
        setNotice(t("om.done.return"));
        setNote("");
      } else {
        await apiFetch(`${base}/restore`, {
          method: "POST",
          body: { note: note.trim(), offer_revision: detail.content_revision },
          idempotencyKey: newIdempotencyKey("offer-hold-restore"),
        });
        setNotice(t("om.done.restore"));
        setNote("");
      }
    } catch (err) {
      setError(apiErrorMessage(err, lang));
      // The store changed something meanwhile: show the current version.
      if (err instanceof ApiError && ["OFFER_CHANGED_SINCE_REVIEW", "CORRECTION_STALE", "OFFER_ALREADY_HELD", "NO_OPEN_HOLD"].includes(err.code)) {
        setNonce((n) => n + 1);
      }
    } finally {
      setBusy(false);
      setPending(null);
      setNonce((n) => n + 1);
    }
  }

  if (gate.status === "loading") {
    return (
      <div className="page-shell">
        <div className="skeleton" style={{ height: 200, width: "100%", maxWidth: 1000 }} />
      </div>
    );
  }
  if (gate.status === "forbidden") {
    return (
      <div className="page-shell">
        <EmptyState title={t("om.forbidden")} actionHref="/account" actionLabel={t("om.account")} />
      </div>
    );
  }

  const hold = detail?.hold ?? null;
  const reasonOk = reason.trim().length >= 3;
  const noteOk = note.trim().length >= 3;
  const correctionCurrent = Boolean(hold?.correction && !hold.correction.stale);
  const canRestore = hold ? hold.action === "HIDE" || correctionCurrent : false;
  const canReturn = Boolean(hold?.action === "REQUEST_CHANGES" && hold.correction);

  const confirmText = pending
    ? {
        HIDE: ["om.confirm.hide.title", "om.confirm.hide.lead", "om.action.hide"],
        REQUEST_CHANGES: ["om.confirm.request.title", "om.confirm.request.lead", "om.action.request"],
        return: ["om.confirm.return.title", "om.confirm.return.lead", "om.action.return"],
        restore: ["om.confirm.restore.title", "om.confirm.restore.lead", "om.action.restore"],
      }[pending.kind]
    : null;

  return (
    <div className="page-shell">
      <div className="wide-shell" style={{ maxWidth: 1000 }}>
        <div className="top-bar">
          <h1 className="page-title" style={{ margin: 0 }}>
            {detail ? (lang === "en" && detail.title_en ? detail.title_en : detail.title_ar) : t("om.title")}
          </h1>
          <Link href="/admin/offers" className="button-link">
            {t("om.back")}
          </Link>
        </div>

        {error && <ErrorBanner message={error} />}
        {notice && (
          <div className="notice-banner" role="status" data-testid="om-notice">
            {notice}
          </div>
        )}
        {loadError !== null && !detail && (
          <div className={styles.unavailable}>
            <span>
              {t("om.detail.loading_failed")} {apiErrorMessage(loadError, lang)}
            </span>
            <button type="button" className="button" onClick={() => setNonce((n) => n + 1)}>
              {t("om.retry")}
            </button>
          </div>
        )}
        {!detail && loadError === null && <div className="skeleton" style={{ height: 200, width: "100%" }} />}

        {detail && (
          <div style={{ display: "grid", gap: 16 }}>
            <section className={styles.panel}>
              <dl className={styles.brandFacts}>
                <div>
                  <dt>{t("om.detail.store")}</dt>
                  <dd>{detail.store.name}</dd>
                </div>
                <div>
                  <dt>{t("om.detail.store_status")}</dt>
                  <dd>{t(`om.vendor.${detail.store.status}`)}</dd>
                </div>
                <div>
                  <dt>{t("om.detail.offer_status")}</dt>
                  <dd>{t(`om.status.${detail.status}`)}</dd>
                </div>
                <div>
                  <dt>{t("om.detail.revision")}</dt>
                  <dd data-testid="om-revision">{detail.content_revision}</dd>
                </div>
                <div>
                  <dt>{t("om.detail.public")}</dt>
                  <dd data-testid="om-public">{t(detail.publicly_visible ? "om.detail.public.yes" : "om.detail.public.no")}</dd>
                </div>
              </dl>
              {detail.publicly_visible && (
                <p style={{ margin: "12px 0 0" }}>
                  <Link href={`/store/${detail.store.slug}/products/${detail.id}`} className="button-link">
                    {t("om.detail.view_public")}
                  </Link>
                </p>
              )}
            </section>

            <section className={styles.panel}>
              <h2 className={styles.panelTitle}>{t("om.detail.variants")}</h2>
              {detail.variants.length === 0 ? (
                <p className={styles.empty}>{t("om.detail.no_variants")}</p>
              ) : (
                <ol className={styles.list} style={{ marginTop: 10 }}>
                  {detail.variants.map((v) => (
                    <li key={v.id} className={styles.row} style={{ gridTemplateColumns: "minmax(0,2fr) minmax(0,1fr) minmax(0,1fr)" }}>
                      <span className={styles.rowPrimary}>{v.sku}</span>
                      <span className={styles.rowRelated}>{[v.colour, v.size].filter(Boolean).join(" · ") || "-"}</span>
                      <span className={styles.rowSince}>{v.base_price}</span>
                    </li>
                  ))}
                </ol>
              )}
            </section>

            <section className={styles.panel} data-testid="om-current">
              <h2 className={styles.panelTitle}>{t("om.detail.current")}</h2>
              {!hold ? (
                <>
                  <p className={styles.empty}>{t("om.detail.none")}</p>
                  <div className="field" style={{ marginTop: 12 }}>
                    <label htmlFor="om-reason">{t("om.field.reason")}</label>
                    <textarea id="om-reason" rows={3} maxLength={1000} value={reason} onChange={(e) => setReason(e.target.value)} />
                  </div>
                  <div className={styles.brandActions}>
                    <button type="button" className="button" disabled={!reasonOk || busy} onClick={() => setPending({ kind: "HIDE" })} data-testid="om-hide">
                      {t("om.action.hide")}
                    </button>
                    <button
                      type="button"
                      className="button button-secondary"
                      disabled={!reasonOk || busy}
                      onClick={() => setPending({ kind: "REQUEST_CHANGES" })}
                      data-testid="om-request"
                    >
                      {t("om.action.request")}
                    </button>
                  </div>
                </>
              ) : (
                <>
                  <dl className={styles.brandFacts} style={{ marginTop: 10 }}>
                    <div>
                      <dt>{t("om.detail.action")}</dt>
                      <dd data-testid="om-hold-action">{t(`om.hold.${hold.action}`)}</dd>
                    </div>
                    <div>
                      <dt>{t("om.detail.reason")}</dt>
                      <dd>{hold.reason}</dd>
                    </div>
                    <div>
                      <dt>{t("om.detail.placed_at")}</dt>
                      <dd>{time(hold.placed_at)}</dd>
                    </div>
                  </dl>
                  {hold.action === "REQUEST_CHANGES" && (
                    <div style={{ marginTop: 12 }} data-testid="om-correction">
                      <strong>{t("om.detail.correction")}</strong>
                      {!hold.correction ? (
                        <p className="muted" style={{ margin: "4px 0" }}>{t("om.detail.no_correction")}</p>
                      ) : (
                        <>
                          <p style={{ margin: "4px 0" }}>
                            {fill(t("om.detail.correction_revision"), { rev: hold.correction.revision })} · {time(hold.correction.submitted_at)}
                          </p>
                          {hold.correction.note && (
                            <p style={{ margin: "4px 0" }}>
                              {t("om.detail.correction_note")}: {hold.correction.note}
                            </p>
                          )}
                          {hold.correction.stale && (
                            <div className="warning-banner">{fill(t("om.detail.correction_stale"), { rev: detail.content_revision })}</div>
                          )}
                        </>
                      )}
                      {hold.last_return && (
                        <p className="muted" style={{ margin: "4px 0" }}>
                          {t("om.detail.last_return")}: {hold.last_return.note}
                        </p>
                      )}
                    </div>
                  )}
                  <p className="muted" style={{ margin: "12px 0 0" }}>
                    {t("om.restore.hint")}
                  </p>
                  {hold.action === "REQUEST_CHANGES" && !correctionCurrent && (
                    <p className="muted" style={{ margin: "4px 0 0" }}>
                      {t("om.restore.needs_correction")}
                    </p>
                  )}
                  <div className="field" style={{ marginTop: 12 }}>
                    <label htmlFor="om-note">{t("om.field.note")}</label>
                    <textarea id="om-note" rows={2} maxLength={1000} value={note} onChange={(e) => setNote(e.target.value)} />
                  </div>
                  <div className={styles.brandActions}>
                    <button
                      type="button"
                      className="button"
                      disabled={!canRestore || !noteOk || busy}
                      onClick={() => setPending({ kind: "restore" })}
                      data-testid="om-restore"
                    >
                      {t("om.action.restore")}
                    </button>
                    {hold.action === "REQUEST_CHANGES" && (
                      <button
                        type="button"
                        className="button button-secondary"
                        disabled={!canReturn || !noteOk || busy}
                        onClick={() => setPending({ kind: "return" })}
                        data-testid="om-return"
                      >
                        {t("om.action.return")}
                      </button>
                    )}
                  </div>
                </>
              )}
            </section>

            <section className={styles.panel}>
              <h2 className={styles.panelTitle}>{t("om.detail.history")}</h2>
              {detail.history.length === 0 ? (
                <p className={styles.empty}>{t("om.detail.history_empty")}</p>
              ) : (
                <ol className={styles.list} style={{ marginTop: 10 }} data-testid="om-history">
                  {detail.history.map((h) => (
                    <li key={h.id} className={styles.row} style={{ gridTemplateColumns: "minmax(0,1fr)" }}>
                      <strong className={styles.rowPrimary}>
                        {t(`om.hold.${h.action}`)} · {time(h.placed_at)}
                      </strong>
                      <span className={styles.rowSecondary}>{h.reason}</span>
                      {h.released && (
                        <span className={styles.rowSecondary}>
                          {fill(t("om.detail.released"), { time: time(h.released.released_at), note: h.released.note })}
                        </span>
                      )}
                    </li>
                  ))}
                </ol>
              )}
            </section>
          </div>
        )}
      </div>

      {pending && confirmText && (
        <SmallConfirm
          title={t(confirmText[0])}
          lead={fill(t(confirmText[1]), { rev: detail?.content_revision ?? "" })}
          confirmLabel={t(confirmText[2])}
          cancelLabel={t("om.confirm.cancel")}
          busy={busy}
          tone={pending.kind === "restore" ? "primary" : "danger"}
          onConfirm={() => void run()}
          onCancel={() => setPending(null)}
        />
      )}
    </div>
  );
}
