"use client";

import "@/lib/adminUsersText";
import "@/lib/adminOrdersText";
import Link from "next/link";
import { useParams } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { SmallConfirm } from "@/components/owner/collections/SmallConfirm";
import { EmptyState, ErrorBanner } from "@/components/States";
import { apiFetch, ApiError, newIdempotencyKey } from "@/lib/api";
import { formatMoney, statusTone } from "@/lib/adminOrdersText";
import { apiErrorMessage } from "@/lib/apiErrors";
import { useAdminGate } from "@/lib/useAdminGate";
import { useLang, useT } from "@/lib/useLang";
import styles from "../../approvals/approvals.module.css";

// VIA phase 3 - one account: profile (masked phone), platform role, state,
// store memberships (store work) apart from their own purchases (customer),
// history, and the platform actions - suspend / lift / sign out
// everywhere, each with a reason and a confirmation. The API refuses a
// PLATFORM_ADMIN and the sole enabled owner of a store; this page explains.

interface Detail {
  id: string;
  display_name: string | null;
  phone_masked: string | null;
  phone_verified: boolean;
  language: string;
  platform_role: "PLATFORM_ADMIN" | "VERIFICATION_REVIEWER" | null;
  status: "ACTIVE" | "SUSPENDED" | "DEACTIVATED";
  created_at: string;
  deactivated_at: string | null;
  suspension: { at: string; reason: string | null; by_self: boolean } | null;
  counts: { orders: number; reviews: number };
  memberships: {
    store_id: string;
    store_name: string;
    store_status: string;
    role: "OWNER" | "BRANCH_EMPLOYEE";
    status: "ACTIVE" | "SUSPENDED";
    branch_name: string | null;
  }[];
  recent_orders: {
    id: string;
    number: string;
    status: string;
    total: number;
    store_name: string;
    created_at: string;
  }[];
  history: { id: string; action: string; at: string; actor: string }[];
  actions: {
    protected: boolean;
    is_self: boolean;
    sole_owner_of: { store_id: string; store_name: string }[];
    can_suspend: boolean;
    can_lift: boolean;
    can_force_sign_out: boolean;
  };
}

type Pending = "suspend" | "lift" | "sign_out";
const danger = {
  background: "var(--color-danger-bg)",
  color: "var(--color-danger)",
};

export default function AdminUserDetailPage() {
  const gate = useAdminGate("ADMIN");
  const t = useT();
  const lang = useLang();
  const { userId } = useParams<{ userId: string }>();
  const [detail, setDetail] = useState<Detail | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [missing, setMissing] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [reason, setReason] = useState("");
  const [note, setNote] = useState("");
  const [pending, setPending] = useState<Pending | null>(null);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const fetchDetail = useCallback(
    () => apiFetch<Detail>(`/admin/users/${userId}`),
    [userId],
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

  async function run() {
    if (!pending) return;
    setBusy(true);
    setActionError(null);
    const path = {
      suspend: "suspend",
      lift: "lift-suspension",
      sign_out: "force-sign-out",
    }[pending];
    const body =
      pending === "lift" ? { note: note.trim() } : { reason: reason.trim() };
    try {
      await apiFetch(`/admin/users/${userId}/${path}`, {
        method: "POST",
        body,
        idempotencyKey: newIdempotencyKey(`admin-user-${path}`),
      });
      setNotice(t(`au.done.${pending}`));
      setReason("");
      setNote("");
      setDetail(await fetchDetail());
    } catch (err) {
      setActionError(apiErrorMessage(err, lang));
    } finally {
      setBusy(false);
      setPending(null);
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
          title={t("au.forbidden")}
          actionHref="/account"
          actionLabel={t("au.account")}
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
  const reasonOk = reason.trim().length >= 5;
  const noteOk = note.trim().length >= 5;

  return (
    <div className="page-shell">
      <div className="wide-shell" style={{ maxWidth: 1100 }}>
        <p style={{ margin: "0 0 8px" }}>
          <Link href="/admin/users" className="button-link">
            {t("au.back")}
          </Link>
        </p>
        {missing && (
          <EmptyState
            title={t("au.not_found")}
            actionHref="/admin/users"
            actionLabel={t("au.back")}
          />
        )}
        {error !== null && (
          <div className={styles.unavailable} role="alert">
            <span>
              {t("au.load_failed")} {apiErrorMessage(error, lang)}
            </span>
            <button
              type="button"
              className="button"
              onClick={() => {
                setError(null);
                setAttempt((a) => a + 1);
              }}
            >
              {t("au.retry")}
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
                {detail.display_name ?? t("au.no_name")}
              </h1>
              <span
                className="badge"
                style={detail.status === "ACTIVE" ? undefined : danger}
                data-testid="au-status"
              >
                {t(`au.status.${detail.status}`)}
              </span>
              {detail.platform_role && (
                <span className="badge badge-active">
                  {t(`au.role.${detail.platform_role}`)}
                </span>
              )}
            </div>
            {notice && (
              <p className="notice" role="status" data-testid="au-notice">
                {notice}
              </p>
            )}

            <section className={styles.panel}>
              <h2 className={styles.panelTitle}>{t("au.d.profile")}</h2>
              <dl className={styles.brandFacts}>
                <div>
                  <dt>{t("au.d.phone")}</dt>
                  <dd data-testid="au-phone" title={t("au.d.phone_hint")}>
                    <bdi dir="ltr">{detail.phone_masked}</bdi>
                  </dd>
                </div>
                <div>
                  <dt>{t("au.d.verified")}</dt>
                  <dd>
                    {detail.phone_verified ? t("au.d.yes") : t("au.d.no")}
                  </dd>
                </div>
                <div>
                  <dt>{t("au.d.platform_role")}</dt>
                  <dd>
                    {detail.platform_role
                      ? t(`au.role.${detail.platform_role}`)
                      : t("au.d.none")}
                  </dd>
                </div>
                <div>
                  <dt>{t("au.d.language")}</dt>
                  <dd>{detail.language === "en" ? "English" : "العربية"}</dd>
                </div>
                <div>
                  <dt>{t("au.d.created")}</dt>
                  <dd>{time(detail.created_at)}</dd>
                </div>
                <div>
                  <dt>{t("au.d.orders")}</dt>
                  <dd>{detail.counts.orders}</dd>
                </div>
                <div>
                  <dt>{t("au.d.reviews")}</dt>
                  <dd>{detail.counts.reviews}</dd>
                </div>
                {detail.deactivated_at && (
                  <div>
                    <dt>{t("au.d.deactivated_at")}</dt>
                    <dd>{time(detail.deactivated_at)}</dd>
                  </div>
                )}
              </dl>
              {detail.suspension && (
                <dl
                  className={styles.brandFacts}
                  style={{ marginTop: 12 }}
                  data-testid="au-suspension"
                >
                  <div>
                    <dt>{t("au.d.suspended_at")}</dt>
                    <dd>{time(detail.suspension.at)}</dd>
                  </div>
                  <div>
                    <dt>{t("au.d.suspension_reason")}</dt>
                    <dd>{detail.suspension.reason}</dd>
                  </div>
                </dl>
              )}
            </section>

            <section className={styles.panel}>
              <h2 className={styles.panelTitle}>{t("au.d.memberships")}</h2>
              <p className={styles.lead} style={{ marginTop: 0 }}>
                {t("au.d.memberships_lead")}
              </p>
              {detail.memberships.length === 0 ? (
                <p className={styles.empty}>{t("au.d.no_memberships")}</p>
              ) : (
                <ol className={styles.list} data-testid="au-memberships">
                  {detail.memberships.map((m) => (
                    <li
                      key={m.store_id}
                      className={styles.row}
                      style={{ gridTemplateColumns: "minmax(0,1fr) auto" }}
                    >
                      <div className={styles.rowMain}>
                        <strong className={styles.rowPrimary}>
                          <Link href={`/admin/vendors/${m.store_id}`}>
                            {m.store_name}
                          </Link>
                        </strong>
                        <span className={styles.rowSecondary}>
                          {t(`au.store_role.${m.role}`)}
                          {m.branch_name ? ` · ${m.branch_name}` : ""}
                        </span>
                      </div>
                      {m.status === "SUSPENDED" && (
                        <span className="badge" style={danger}>
                          {t("au.d.membership_suspended")}
                        </span>
                      )}
                    </li>
                  ))}
                </ol>
              )}
            </section>

            <section className={styles.panel}>
              <h2 className={styles.panelTitle}>{t("au.d.orders_title")}</h2>
              <p className={styles.lead} style={{ marginTop: 0 }}>
                {t("au.d.orders_lead")}
              </p>
              {detail.recent_orders.length === 0 ? (
                <p className={styles.empty}>{t("au.d.no_orders")}</p>
              ) : (
                <ol className={styles.list} data-testid="au-orders">
                  {detail.recent_orders.map((o) => (
                    <li
                      key={o.id}
                      className={styles.row}
                      style={{ gridTemplateColumns: "minmax(0,1fr) auto auto" }}
                    >
                      <div className={styles.rowMain}>
                        <strong className={styles.rowPrimary}>
                          <Link href={`/admin/orders/${o.id}`}>
                            <bdi>#{o.number}</bdi>
                          </Link>
                        </strong>
                        <span className={styles.rowSecondary}>
                          {o.store_name} · {time(o.created_at)}
                        </span>
                      </div>
                      <span className="badge" style={statusTone(o.status)}>
                        {t(`ao.status.${o.status}`)}
                      </span>
                      <bdi>{formatMoney(o.total, lang)}</bdi>
                    </li>
                  ))}
                </ol>
              )}
            </section>

            <section className={styles.panel}>
              <h2 className={styles.panelTitle}>{t("au.d.actions")}</h2>
              {actionError && <ErrorBanner message={actionError} />}
              {detail.actions.protected ? (
                <p className={styles.empty} data-testid="au-protected">
                  {t("au.d.protected")}
                </p>
              ) : (
                <div style={{ display: "grid", gap: 12 }}>
                  {detail.actions.sole_owner_of.length > 0 &&
                    !detail.suspension && (
                      <p className={styles.empty} data-testid="au-sole-owner">
                        {t("au.d.sole_owner")}{" "}
                        {detail.actions.sole_owner_of
                          .map((s) => s.store_name)
                          .join("، ")}
                      </p>
                    )}
                  {detail.actions.can_lift ? (
                    <>
                      <div className="field">
                        <label htmlFor="au-note">{t("au.d.note")}</label>
                        <textarea
                          id="au-note"
                          rows={2}
                          maxLength={500}
                          value={note}
                          onChange={(e) => setNote(e.target.value)}
                        />
                      </div>
                      {detail.deactivated_at && (
                        <p className={styles.lead}>
                          {t("au.d.lift_keeps_deactivation")}
                        </p>
                      )}
                      <div className={styles.brandActions}>
                        <button
                          type="button"
                          className="button"
                          disabled={!noteOk || busy}
                          onClick={() => setPending("lift")}
                          data-testid="au-lift"
                        >
                          {t("au.d.lift")}
                        </button>
                      </div>
                    </>
                  ) : (
                    <>
                      <div className="field">
                        <label htmlFor="au-reason">{t("au.d.reason")}</label>
                        <textarea
                          id="au-reason"
                          rows={2}
                          maxLength={500}
                          value={reason}
                          onChange={(e) => setReason(e.target.value)}
                        />
                      </div>
                      <div className={styles.brandActions}>
                        <button
                          type="button"
                          className="button"
                          disabled={
                            !reasonOk || busy || !detail.actions.can_suspend
                          }
                          onClick={() => setPending("suspend")}
                          data-testid="au-suspend"
                        >
                          {t("au.d.suspend")}
                        </button>
                        <button
                          type="button"
                          className="button button-secondary"
                          disabled={
                            !reasonOk ||
                            busy ||
                            !detail.actions.can_force_sign_out
                          }
                          onClick={() => setPending("sign_out")}
                          data-testid="au-sign-out"
                        >
                          {t("au.d.sign_out")}
                        </button>
                      </div>
                    </>
                  )}
                </div>
              )}
            </section>

            <section className={styles.panel}>
              <h2 className={styles.panelTitle}>{t("au.d.history")}</h2>
              {detail.history.length === 0 ? (
                <p className={styles.empty}>{t("au.d.no_history")}</p>
              ) : (
                <ol className={styles.list} data-testid="au-history">
                  {detail.history.map((h) => (
                    <li
                      key={h.id}
                      className={styles.row}
                      style={{ gridTemplateColumns: "minmax(0,1fr) auto" }}
                    >
                      <div className={styles.rowMain}>
                        <strong className={styles.rowPrimary}>
                          <bdi dir="ltr">{h.action}</bdi>
                        </strong>
                        <span className={styles.rowSecondary}>
                          {t(`au.actor.${h.actor}`)}
                        </span>
                      </div>
                      <span className={styles.rowSecondary}>{time(h.at)}</span>
                    </li>
                  ))}
                </ol>
              )}
            </section>
          </div>
        )}
      </div>

      {pending && (
        <SmallConfirm
          title={t(`au.confirm.${pending}.title`)}
          lead={t(`au.confirm.${pending}.lead`)}
          confirmLabel={t("au.confirm.ok")}
          cancelLabel={t("au.confirm.cancel")}
          busy={busy}
          tone={pending === "lift" ? "primary" : "danger"}
          onConfirm={() => void run()}
          onCancel={() => setPending(null)}
        />
      )}
    </div>
  );
}
