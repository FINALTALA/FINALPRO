"use client";

import "@/lib/mediaLibraryText";
import Link from "next/link";
import { useParams } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { SmallConfirm } from "@/components/owner/collections/SmallConfirm";
import { EmptyState, ErrorBanner } from "@/components/States";
import { apiFetch, ApiError, newIdempotencyKey } from "@/lib/api";
import { apiErrorMessage } from "@/lib/apiErrors";
import { bytes, fill, mediaUrl } from "@/lib/mediaLibraryText";
import { useAdminGate } from "@/lib/useAdminGate";
import { useLang, useT } from "@/lib/useLang";
import styles from "../../approvals/approvals.module.css";

// VIA phase 5 - one media asset: a signed preview (video with seeking),
// its validated metadata, where it is used (usage blocks archive and
// purge), and the lifecycle actions with confirmations.

interface Detail {
  id: string;
  name: string;
  category: string;
  kind: "IMAGE" | "VIDEO";
  mime_type: string;
  size_bytes: number;
  width: number;
  height: number;
  duration_ms: number | null;
  video_codec: string | null;
  audio_codec: string | null;
  sha256: string;
  validation_state: string;
  status: "ACTIVE" | "ARCHIVED" | "PURGING";
  created_at: string;
  archived_at: string | null;
  purge_eligible_at: string | null;
  preview_url: string | null;
  public_url: string | null;
  uploaded_by_name: string | null;
  usages: {
    id: string;
    owner_type: string;
    owner_id: string;
    revision_id: string | null;
    state: string;
    label: string | null;
  }[];
  actions: { can_archive: boolean; can_restore: boolean; can_purge: boolean };
}
type Action = "archive" | "restore" | "purge";

export default function AdminMediaDetailPage() {
  const gate = useAdminGate("ADMIN");
  const t = useT();
  const lang = useLang();
  const { mediaId } = useParams<{ mediaId: string }>();
  const [d, setD] = useState<Detail | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [missing, setMissing] = useState(false);
  const [pending, setPending] = useState<Action | null>(null);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);

  const fetchDetail = useCallback(
    () => apiFetch<Detail>(`/admin/media/${mediaId}`),
    [mediaId],
  );

  useEffect(() => {
    if (gate.status !== "ok") return;
    let cancelled = false;
    fetchDetail()
      .then((x) => !cancelled && setD(x))
      .catch((e) => {
        if (cancelled) return;
        if (e instanceof ApiError && e.status === 404) setMissing(true);
        else setError(e);
      });
    return () => {
      cancelled = true;
    };
  }, [gate.status, fetchDetail, attempt]);

  async function run() {
    if (!pending) return;
    setBusy(true);
    setActionError(null);
    try {
      const r = await apiFetch<{ purged?: boolean }>(
        `/admin/media/${mediaId}/${pending}`,
        {
          method: "POST",
          body: {},
          idempotencyKey: newIdempotencyKey(`media-${pending}`),
        },
      );
      if (pending === "purge") {
        setNotice(r.purged ? t("ml.done.purge") : t("ml.done.purge_pending"));
        if (r.purged) {
          setD(null);
          setMissing(true);
          return;
        }
      } else {
        setNotice(t(`ml.done.${pending}`));
      }
      setD(await fetchDetail());
    } catch (e) {
      setActionError(apiErrorMessage(e, lang));
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
          title={t("ml.forbidden")}
          actionHref="/account"
          actionLabel={t("ml.account")}
        />
      </div>
    );
  }

  const locale = lang === "ar" ? "ar" : "en-GB";
  const time = (iso: string | null) =>
    iso
      ? new Date(iso).toLocaleString(locale, {
          dateStyle: "medium",
          timeStyle: "short",
        })
      : "-";

  return (
    <div className="page-shell">
      <div
        className="wide-shell"
        style={{
          maxWidth: 1100,
          display: "grid",
          gridTemplateColumns: "minmax(0, 1fr)",
          gap: 16,
        }}
      >
        <p style={{ margin: 0 }}>
          <Link href="/admin/media" className="button-link">
            {t("ml.back")}
          </Link>
        </p>
        {notice && (
          <p className="notice" role="status" data-testid="ml-notice">
            {notice}
          </p>
        )}
        {missing && (
          <EmptyState
            title={t("ml.not_found")}
            actionHref="/admin/media"
            actionLabel={t("ml.back")}
          />
        )}
        {error !== null && (
          <div className={styles.unavailable} role="alert">
            <span>
              {t("ml.load_failed")} {apiErrorMessage(error, lang)}
            </span>
            <button
              type="button"
              className="button"
              onClick={() => setAttempt((a) => a + 1)}
            >
              {t("ml.retry")}
            </button>
          </div>
        )}
        {!d && !missing && error === null && (
          <div
            className="skeleton"
            aria-busy="true"
            style={{ height: 300, width: "100%" }}
          />
        )}

        {d && (
          <>
            <div className="top-bar" style={{ flexWrap: "wrap", gap: 8 }}>
              <h1
                className="page-title"
                style={{ margin: 0, overflowWrap: "anywhere" }}
              >
                {d.name}
              </h1>
              <span
                className={`badge${d.status === "ACTIVE" ? " badge-active" : ""}`}
                data-testid="ml-status"
              >
                {t(`ml.status.${d.status}`)}
              </span>
            </div>

            <section className={styles.panel}>
              {d.preview_url &&
                (d.kind === "IMAGE" ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={mediaUrl(d.preview_url)!}
                    alt={d.name}
                    style={{
                      maxWidth: "100%",
                      maxHeight: 480,
                      display: "block",
                      margin: "0 auto",
                      borderRadius: 10,
                    }}
                    data-testid="ml-preview"
                  />
                ) : (
                  <video
                    src={mediaUrl(d.preview_url)!}
                    controls
                    playsInline
                    preload="metadata"
                    style={{
                      maxWidth: "100%",
                      maxHeight: 480,
                      display: "block",
                      margin: "0 auto",
                      borderRadius: 10,
                    }}
                    data-testid="ml-preview"
                  />
                ))}
            </section>

            <section className={styles.panel}>
              <h2 className={styles.panelTitle}>{t("ml.d.details")}</h2>
              <dl className={styles.brandFacts}>
                <div>
                  <dt>{t("ml.d.type")}</dt>
                  <dd>
                    {t(`ml.kind.${d.kind}`)} · <bdi>{d.mime_type}</bdi>
                  </dd>
                </div>
                <div>
                  <dt>{t("ml.category")}</dt>
                  <dd>{t(`ml.cat.${d.category}`)}</dd>
                </div>
                <div>
                  <dt>{t("ml.d.size")}</dt>
                  <dd>
                    <bdi>{bytes(d.size_bytes, lang)}</bdi>
                  </dd>
                </div>
                <div>
                  <dt>{t("ml.d.dimensions")}</dt>
                  <dd>
                    <bdi>
                      {d.width}×{d.height}
                    </bdi>
                  </dd>
                </div>
                {d.duration_ms !== null && (
                  <div>
                    <dt>{t("ml.d.duration")}</dt>
                    <dd>
                      <bdi>
                        {(d.duration_ms / 1000).toLocaleString(locale, {
                          maximumFractionDigits: 1,
                        })}{" "}
                        s
                      </bdi>
                    </dd>
                  </div>
                )}
                {d.video_codec && (
                  <div>
                    <dt>{t("ml.d.codecs")}</dt>
                    <dd>
                      <bdi dir="ltr">
                        {[d.video_codec, d.audio_codec]
                          .filter(Boolean)
                          .join(" + ")}
                      </bdi>
                    </dd>
                  </div>
                )}
                <div>
                  <dt>{t("ml.d.validation")}</dt>
                  <dd>{t("ml.d.valid")}</dd>
                </div>
                <div>
                  <dt>{t("ml.d.uploaded")}</dt>
                  <dd>{time(d.created_at)}</dd>
                </div>
                <div>
                  <dt>{t("ml.d.uploader")}</dt>
                  <dd>{d.uploaded_by_name ?? "-"}</dd>
                </div>
                <div>
                  <dt>{t("ml.d.sha")}</dt>
                  <dd>
                    <bdi
                      dir="ltr"
                      style={{ fontSize: 11.5, overflowWrap: "anywhere" }}
                    >
                      {d.sha256}
                    </bdi>
                  </dd>
                </div>
              </dl>
              <p
                style={{ margin: "10px 0 0", fontSize: 12.5 }}
                data-testid="ml-public"
              >
                {d.public_url ? (
                  <>
                    {t("ml.d.public_url")}:{" "}
                    <bdi dir="ltr" style={{ overflowWrap: "anywhere" }}>
                      {mediaUrl(d.public_url)}
                    </bdi>
                  </>
                ) : (
                  <span style={{ color: "var(--color-text-muted)" }}>
                    {t("ml.d.no_public")}
                  </span>
                )}
              </p>
            </section>

            <section className={styles.panel}>
              <h2 className={styles.panelTitle}>{t("ml.d.usage")}</h2>
              <p className={styles.lead} style={{ marginTop: 0 }}>
                {t("ml.d.usage_lead")}
              </p>
              {d.usages.length === 0 ? (
                <p className={styles.empty} data-testid="ml-no-usage">
                  {t("ml.d.no_usage")}
                </p>
              ) : (
                <ol className={styles.list} data-testid="ml-usages">
                  {d.usages.map((u) => (
                    <li
                      key={u.id}
                      className={styles.row}
                      style={{ gridTemplateColumns: "minmax(0,1fr) auto" }}
                    >
                      <div className={styles.rowMain}>
                        <strong className={styles.rowPrimary}>
                          <bdi dir="ltr">{u.owner_type}</bdi> ·{" "}
                          <bdi dir="ltr">{u.label ?? u.owner_id}</bdi>
                        </strong>
                        {u.revision_id && (
                          <span className={styles.rowSecondary}>
                            <bdi dir="ltr">{u.revision_id}</bdi>
                          </span>
                        )}
                      </div>
                      <span className="badge">{t(`ml.usage.${u.state}`)}</span>
                    </li>
                  ))}
                </ol>
              )}
            </section>

            <section className={styles.panel}>
              <h2 className={styles.panelTitle}>{t("ml.d.actions")}</h2>
              {actionError && <ErrorBanner message={actionError} />}
              <div className={styles.brandActions}>
                {d.status === "ACTIVE" && (
                  <button
                    type="button"
                    className="button"
                    disabled={!d.actions.can_archive || busy}
                    onClick={() => setPending("archive")}
                    data-testid="ml-archive"
                  >
                    {t("ml.archive")}
                  </button>
                )}
                {d.status === "ARCHIVED" && (
                  <>
                    <button
                      type="button"
                      className="button"
                      disabled={busy}
                      onClick={() => setPending("restore")}
                      data-testid="ml-restore"
                    >
                      {t("ml.restore")}
                    </button>
                    <button
                      type="button"
                      className="button button-secondary"
                      disabled={!d.actions.can_purge || busy}
                      onClick={() => setPending("purge")}
                      data-testid="ml-purge"
                    >
                      {t("ml.purge")}
                    </button>
                  </>
                )}
              </div>
              {d.status === "ACTIVE" && !d.actions.can_archive && (
                <p className={styles.empty} data-testid="ml-archive-blocked">
                  {t("ml.archive_blocked")}
                </p>
              )}
              {d.status === "ARCHIVED" &&
                !d.actions.can_purge &&
                d.purge_eligible_at && (
                  <p className={styles.empty} data-testid="ml-purge-when">
                    {fill(t("ml.purge_when"), {
                      at: time(d.purge_eligible_at),
                    })}
                  </p>
                )}
            </section>
          </>
        )}
      </div>

      {pending && (
        <SmallConfirm
          title={t(`ml.confirm.${pending}.title`)}
          lead={t(`ml.confirm.${pending}.lead`)}
          confirmLabel={t("ml.confirm.ok")}
          cancelLabel={t("ml.confirm.cancel")}
          busy={busy}
          tone={pending === "restore" ? "primary" : "danger"}
          onConfirm={() => void run()}
          onCancel={() => setPending(null)}
        />
      )}
    </div>
  );
}
