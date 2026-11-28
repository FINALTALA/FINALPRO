"use client";

import "@/lib/mediaLibraryText";
import Link from "next/link";
import { FormEvent, useCallback, useEffect, useRef, useState } from "react";
import { EmptyState, ErrorBanner } from "@/components/States";
import { apiFetch, authHeadersFor } from "@/lib/api";
import { apiErrorMessage } from "@/lib/apiErrors";
import {
  bytes,
  fill,
  MEDIA_CATEGORIES,
  mediaUrl,
} from "@/lib/mediaLibraryText";
import { useAdminGate } from "@/lib/useAdminGate";
import { useLang, useT } from "@/lib/useLang";
import styles from "../approvals/approvals.module.css";

// VIA phase 5 - the Media Library: upload (validated on the server from
// the real bytes), search and filter, a grid of signed previews; each
// opens its detail page with usage and the archive / restore / purge
// actions. PLATFORM_ADMIN only.

interface MediaItem {
  id: string;
  name: string;
  category: (typeof MEDIA_CATEGORIES)[number];
  kind: "IMAGE" | "VIDEO";
  mime_type: string;
  size_bytes: number;
  width: number;
  height: number;
  duration_ms: number | null;
  status: "ACTIVE" | "ARCHIVED" | "PURGING";
  created_at: string;
  usage_count: number;
  preview_url: string | null;
}

const API_BASE_URL =
  process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3001/api/v1";
const EMPTY = { q: "", category: "all", kind: "all", status: "ACTIVE" };

export default function AdminMediaPage() {
  const gate = useAdminGate("ADMIN");
  const t = useT();
  const lang = useLang();
  const [draft, setDraft] = useState(EMPTY);
  const [filters, setFilters] = useState(EMPTY);
  const [items, setItems] = useState<MediaItem[] | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [attempt, setAttempt] = useState(0);
  const [loadingMore, setLoadingMore] = useState(false);
  const [up, setUp] = useState({ category: "HOMEPAGE", name: "" });
  const [uploading, setUploading] = useState(false);
  const [upError, setUpError] = useState<string | null>(null);
  const [upNotice, setUpNotice] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const query = useCallback(
    (after: string | null) => {
      const qs = new URLSearchParams({ limit: "24", status: filters.status });
      if (filters.q.trim()) qs.set("q", filters.q.trim());
      if (filters.category !== "all") qs.set("category", filters.category);
      if (filters.kind !== "all") qs.set("kind", filters.kind);
      if (after) qs.set("cursor", after);
      return apiFetch<{ items: MediaItem[]; next_cursor: string | null }>(
        `/admin/media?${qs}`,
      );
    },
    [filters],
  );

  useEffect(() => {
    if (gate.status !== "ok") return;
    let cancelled = false;
    query(null)
      .then((p) => {
        if (cancelled) return;
        setItems(p.items);
        setCursor(p.next_cursor);
      })
      .catch((e) => !cancelled && setError(e));
    return () => {
      cancelled = true;
    };
  }, [gate.status, query, attempt]);

  function load(next: typeof EMPTY) {
    setItems(null);
    setError(null);
    setCursor(null);
    setFilters(next);
    setAttempt((a) => a + 1);
  }

  async function more() {
    if (!cursor) return;
    setLoadingMore(true);
    try {
      const p = await query(cursor);
      setItems((prev) => [...(prev ?? []), ...p.items]);
      setCursor(p.next_cursor);
    } catch (e) {
      setError(e);
    } finally {
      setLoadingMore(false);
    }
  }

  async function upload(e: FormEvent) {
    e.preventDefault();
    const file = fileRef.current?.files?.[0];
    if (!file) return;
    setUploading(true);
    setUpError(null);
    setUpNotice(null);
    try {
      const qs = new URLSearchParams({ category: up.category });
      if (up.name.trim()) qs.set("name", up.name.trim());
      const path = `/admin/media?${qs}`;
      const body = new FormData();
      body.append("file", file);
      const res = await fetch(`${API_BASE_URL}${path}`, {
        method: "POST",
        headers: authHeadersFor(path),
        body,
      });
      const json = await res.json().catch(() => null);
      if (!res.ok) {
        const reason = json?.error?.details?.[0]?.reason;
        setUpError(
          `${json?.error?.message ?? res.status}${reason ? ` (${reason})` : ""}`,
        );
        return;
      }
      setUpNotice(t("ml.uploaded"));
      setUp({ ...up, name: "" });
      if (fileRef.current) fileRef.current.value = "";
      load(filters);
    } catch (err) {
      setUpError(apiErrorMessage(err, lang));
    } finally {
      setUploading(false);
    }
  }

  if (gate.status === "loading") {
    return (
      <div className="page-shell">
        <div
          className="skeleton"
          style={{ height: 160, width: "100%", maxWidth: 1100 }}
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

  const seconds = (ms: number | null) =>
    ms === null
      ? ""
      : ` · ${(ms / 1000).toLocaleString(lang === "ar" ? "ar" : "en-GB", { maximumFractionDigits: 1 })}s`;

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
        <div className="top-bar">
          <h1 className="page-title" style={{ margin: 0 }}>
            {t("ml.title")}
          </h1>
        </div>
        <p className={styles.lead} style={{ margin: 0 }}>
          {t("ml.lead")}
        </p>

        <form
          className={styles.panel}
          onSubmit={upload}
          data-testid="ml-upload"
        >
          <h2 className={styles.panelTitle}>{t("ml.upload")}</h2>
          <p className={styles.lead} style={{ marginTop: 0 }}>
            {t("ml.upload_lead")}
          </p>
          <div className={styles.filters}>
            <div className="field">
              <label htmlFor="ml-file">{t("ml.file")}</label>
              <input
                id="ml-file"
                ref={fileRef}
                type="file"
                accept="image/jpeg,image/png,image/webp,video/mp4,video/webm"
                required
              />
            </div>
            <div className="field">
              <label htmlFor="ml-up-category">{t("ml.category")}</label>
              <select
                id="ml-up-category"
                value={up.category}
                onChange={(e) => setUp({ ...up, category: e.target.value })}
              >
                {MEDIA_CATEGORIES.map((c) => (
                  <option key={c} value={c}>
                    {t(`ml.cat.${c}`)}
                  </option>
                ))}
              </select>
            </div>
            <div className="field">
              <label htmlFor="ml-name">{t("ml.name")}</label>
              <input
                id="ml-name"
                value={up.name}
                maxLength={200}
                onChange={(e) => setUp({ ...up, name: e.target.value })}
              />
            </div>
            <div style={{ display: "flex", alignItems: "end" }}>
              <button
                type="submit"
                className="button"
                disabled={uploading}
                data-testid="ml-upload-submit"
              >
                {uploading ? t("ml.uploading") : t("ml.upload")}
              </button>
            </div>
          </div>
          {upError && <ErrorBanner message={upError} />}
          {upNotice && (
            <p className="notice" role="status" data-testid="ml-upload-notice">
              {upNotice}
            </p>
          )}
        </form>

        <form
          className={`${styles.panel} ${styles.filters}`}
          onSubmit={(e) => {
            e.preventDefault();
            load({ ...draft });
          }}
        >
          <div className="field">
            <label htmlFor="ml-q">{t("ml.search")}</label>
            <input
              id="ml-q"
              type="search"
              value={draft.q}
              onChange={(e) => setDraft({ ...draft, q: e.target.value })}
            />
          </div>
          <div className="field">
            <label htmlFor="ml-category">{t("ml.f.category")}</label>
            <select
              id="ml-category"
              value={draft.category}
              onChange={(e) => setDraft({ ...draft, category: e.target.value })}
            >
              <option value="all">{t("ml.f.all")}</option>
              {MEDIA_CATEGORIES.map((c) => (
                <option key={c} value={c}>
                  {t(`ml.cat.${c}`)}
                </option>
              ))}
            </select>
          </div>
          <div className="field">
            <label htmlFor="ml-kind">{t("ml.f.kind")}</label>
            <select
              id="ml-kind"
              value={draft.kind}
              onChange={(e) => setDraft({ ...draft, kind: e.target.value })}
            >
              <option value="all">{t("ml.f.all")}</option>
              <option value="IMAGE">{t("ml.kind.IMAGE")}</option>
              <option value="VIDEO">{t("ml.kind.VIDEO")}</option>
            </select>
          </div>
          <div className="field">
            <label htmlFor="ml-status">{t("ml.f.status")}</label>
            <select
              id="ml-status"
              value={draft.status}
              onChange={(e) => setDraft({ ...draft, status: e.target.value })}
            >
              {["ACTIVE", "ARCHIVED", "ALL"].map((s) => (
                <option key={s} value={s}>
                  {t(`ml.status.${s}`)}
                </option>
              ))}
            </select>
          </div>
          <div style={{ display: "flex", alignItems: "end" }}>
            <button type="submit" className="button" data-testid="ml-apply">
              {t("ml.apply")}
            </button>
          </div>
        </form>

        {error !== null && (
          <div className={styles.unavailable} role="alert">
            <span>
              {t("ml.load_failed")} {apiErrorMessage(error, lang)}
            </span>
            <button
              type="button"
              className="button"
              onClick={() => load(filters)}
            >
              {t("ml.retry")}
            </button>
          </div>
        )}
        {items === null && error === null && (
          <div
            className="skeleton"
            aria-busy="true"
            style={{ height: 200, width: "100%" }}
          />
        )}
        {items !== null && items.length === 0 && (
          <p className={styles.empty}>{t("ml.empty")}</p>
        )}
        {items !== null && items.length > 0 && (
          <ul
            data-testid="ml-grid"
            style={{
              listStyle: "none",
              margin: 0,
              padding: 0,
              display: "grid",
              gap: 12,
              gridTemplateColumns:
                "repeat(auto-fill, minmax(min(100%, 200px), 1fr))",
            }}
          >
            {items.map((m) => (
              <li
                key={m.id}
                className={styles.panel}
                style={{ padding: 10, display: "grid", gap: 6 }}
                data-testid="ml-item"
                data-id={m.id}
              >
                <div
                  style={{
                    aspectRatio: "4 / 3",
                    background: "var(--color-border)",
                    borderRadius: 10,
                    overflow: "hidden",
                    display: "grid",
                    placeItems: "center",
                  }}
                >
                  {m.preview_url &&
                    (m.kind === "IMAGE" ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img
                        src={mediaUrl(m.preview_url)!}
                        alt={m.name}
                        loading="lazy"
                        style={{
                          width: "100%",
                          height: "100%",
                          objectFit: "cover",
                        }}
                      />
                    ) : (
                      <video
                        src={mediaUrl(m.preview_url)!}
                        muted
                        preload="metadata"
                        style={{
                          width: "100%",
                          height: "100%",
                          objectFit: "cover",
                        }}
                      />
                    ))}
                </div>
                <strong style={{ overflowWrap: "anywhere" }}>{m.name}</strong>
                <span className={styles.rowSecondary}>
                  {t(`ml.kind.${m.kind}`)} · {t(`ml.cat.${m.category}`)} ·{" "}
                  <bdi>{bytes(m.size_bytes, lang)}</bdi>
                  {seconds(m.duration_ms)}
                </span>
                <span style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
                  <span
                    className={`badge${m.status === "ACTIVE" ? " badge-active" : ""}`}
                  >
                    {t(`ml.status.${m.status}`)}
                  </span>
                  <span className="badge">
                    {m.usage_count > 0
                      ? fill(t("ml.used"), { n: m.usage_count })
                      : t("ml.unused")}
                  </span>
                </span>
                <Link href={`/admin/media/${m.id}`} className="button-link">
                  {t("ml.open")}
                </Link>
              </li>
            ))}
          </ul>
        )}
        {cursor && (
          <div className={styles.listFoot}>
            <button
              type="button"
              className="button button-secondary"
              disabled={loadingMore}
              onClick={() => void more()}
            >
              {t("ml.load_more")}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
