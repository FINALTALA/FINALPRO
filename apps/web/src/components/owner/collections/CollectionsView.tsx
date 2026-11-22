"use client";

import { useCallback, useEffect, useState } from "react";
import { IconArrowDown, IconArrowUp, IconCollections, IconEdit, IconEye, IconGrip, IconImage, IconPlus, IconTrash } from "@/components/product-wizard/wizardIcons";
import { ErrorBanner } from "@/components/States";
import { ApiError } from "@/lib/api";
import { collectionName, collectionsApi, MAX_COLLECTIONS, type StoreCollection } from "@/lib/collections";
import "@/lib/collectionsText";
import { fill } from "@/lib/offerWizardText";
import { useLang, useT } from "@/lib/useLang";
import { SmallConfirm } from "./SmallConfirm";

/**
 * «مجموعات المتجر»: the store's own collections in the owner's order -
 * drag a row (desktop) or use its arrows (keyboard, phone); each row says
 * how many products it has, how many shoppers see, and why it is not shown
 * when it is not. «الكل» / «وصل حديثاً» / «تخفيضات» are shown apart, read
 * only - automatic filters, never collections. Shown inside the management
 * window (it replaces the window's content; never a second panel).
 */
export function CollectionsView({ vendorId, onEdit }: { vendorId: string; onEdit: (id: string | null) => void }) {
  const t = useT();
  const lang = useLang();
  const [items, setItems] = useState<StoreCollection[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [deleting, setDeleting] = useState<StoreCollection | null>(null);
  const [dragId, setDragId] = useState<string | null>(null);
  const [status, setStatus] = useState("");

  const load = useCallback(() => {
    collectionsApi
      .list(vendorId)
      .then((r) => {
        setItems(r);
        setError(null);
      })
      .catch((err: unknown) => setError(err instanceof ApiError ? err.message : t("col.load_failed")));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [vendorId]);
  useEffect(() => {
    load();
  }, [load]);

  async function saveOrder(next: StoreCollection[], moved: StoreCollection) {
    setItems(next);
    try {
      await collectionsApi.reorder(vendorId, next.map((c) => c.id));
      setStatus(fill(t("col.moved"), { name: collectionName(moved, lang), n: next.indexOf(moved) + 1 }));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t("col.save_failed"));
      load();
    }
  }
  function move(c: StoreCollection, delta: number) {
    if (!items) return;
    const from = items.indexOf(c);
    const to = from + delta;
    if (to < 0 || to >= items.length) return;
    const next = [...items];
    next.splice(from, 1);
    next.splice(to, 0, c);
    void saveOrder(next, c);
  }
  function dropOn(target: StoreCollection) {
    if (!items || !dragId || dragId === target.id) return;
    const moved = items.find((c) => c.id === dragId);
    if (!moved) return;
    const next = items.filter((c) => c.id !== dragId);
    next.splice(next.indexOf(target) + (items.indexOf(moved) < items.indexOf(target) ? 1 : 0), 0, moved);
    setDragId(null);
    void saveOrder(next, moved);
  }
  async function toggle(c: StoreCollection) {
    setBusy(true);
    try {
      await collectionsApi.update(vendorId, c.id, { visible: !c.visible });
      load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t("col.save_failed"));
    } finally {
      setBusy(false);
    }
  }
  async function confirmDelete() {
    if (!deleting) return;
    setBusy(true);
    try {
      await collectionsApi.remove(vendorId, deleting.id);
      setDeleting(null);
      load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t("col.save_failed"));
    } finally {
      setBusy(false);
    }
  }

  const full = (items?.length ?? 0) >= MAX_COLLECTIONS;
  return (
    <div className="owner-catalog owner-embedded col-view" data-testid="collections-view">
      <header className="col-head">
        <div className="col-head-text">
          <h1 className="page-title col-title">{t("col.title")}</h1>
          <p className="wz-lead">{t("col.lead")}</p>
        </div>
        <div className="col-head-tools">
          {items && <span className="col-count">{fill(t("col.count"), { n: items.length })}</span>}
          <button type="button" className="button owner-primary" onClick={() => onEdit(null)} disabled={full} data-testid="collections-new">
            <IconPlus /> {t("col.new")}
          </button>
        </div>
      </header>
      {full && <p className="wz-hint">{t("col.limit_reached")}</p>}
      {error && <ErrorBanner message={error} />}
      <p className="visually-hidden" role="status" aria-live="polite">{status}</p>

      {items === null && !error && <div className="skeleton" style={{ height: 160 }} />}
      {items && items.length === 0 && (
        <div className="col-empty">
          <span className="col-empty-icon" aria-hidden="true"><IconCollections /></span>
          <strong>{t("col.empty_title")}</strong>
          <p className="muted">{t("col.empty_lead")}</p>
        </div>
      )}
      {items && items.length > 0 && (
        <ol className="col-list" aria-label={t("col.title")}>
          {items.map((c, i) => {
            const name = collectionName(c, lang);
            const note = !c.visible ? t("col.not_shown_hidden") : c.shopper_count === 0 ? t("col.not_shown_empty") : null;
            return (
              <li
                key={c.id}
                className={`col-row${dragId === c.id ? " is-dragging" : ""}${c.visible ? "" : " is-hidden"}`}
                draggable
                onDragStart={(e) => {
                  setDragId(c.id);
                  e.dataTransfer.effectAllowed = "move";
                }}
                onDragEnd={() => setDragId(null)}
                onDragOver={(e) => {
                  if (dragId) e.preventDefault();
                }}
                onDrop={(e) => {
                  e.preventDefault();
                  dropOn(c);
                }}
                data-testid={`collection-row-${c.id}`}
              >
                <span className="col-grip" aria-hidden="true" title={fill(t("col.drag"), { name })}><IconGrip /></span>
                {c.cover_url ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={c.cover_url} alt="" className="col-thumb" />
                ) : (
                  <span className="col-thumb col-thumb-empty" aria-hidden="true"><IconImage /></span>
                )}
                <div className="col-text">
                  <strong className="col-name">{name}</strong>
                  {lang !== "en" && c.name_en && <span className="col-name-en" dir="ltr" lang="en">{c.name_en}</span>}
                  <span className="col-meta">
                    <span>{fill(t("col.products"), { n: c.product_count })}</span>
                    <span aria-hidden="true">·</span>
                    <span>{fill(t("col.shown"), { n: c.shopper_count })}</span>
                    <span className={`col-chip ${c.visible ? "is-on" : "is-off"}`}>{c.visible ? t("col.visible") : t("col.hidden")}</span>
                  </span>
                  {note && (
                    <span className={`col-note${c.visible ? " is-warn" : ""}`} data-testid={`collection-note-${c.id}`}>
                      {note}
                    </span>
                  )}
                </div>
                <div className="col-actions">
                  <span className="col-arrows">
                    <button type="button" className="col-icon-btn" onClick={() => move(c, -1)} disabled={i === 0} aria-label={fill(t("col.move_up"), { name })} title={fill(t("col.move_up"), { name })}>
                      <IconArrowUp />
                    </button>
                    <button type="button" className="col-icon-btn" onClick={() => move(c, 1)} disabled={i === items.length - 1} aria-label={fill(t("col.move_down"), { name })} title={fill(t("col.move_down"), { name })}>
                      <IconArrowDown />
                    </button>
                  </span>
                  <button type="button" className="button-link owner-secondary col-edit" onClick={() => onEdit(c.id)} data-testid={`collection-edit-${c.id}`}>
                    <IconEdit /> {t("col.edit")}
                  </button>
                  <button type="button" className="button-link wz-ghost col-toggle" onClick={() => void toggle(c)} disabled={busy} aria-label={`${c.visible ? t("col.hide") : t("col.show")}: ${name}`} data-testid={`collection-toggle-${c.id}`}>
                    <IconEye /> {c.visible ? t("col.hide") : t("col.show")}
                  </button>
                  <button type="button" className="button-link wz-ghost col-delete" onClick={() => setDeleting(c)} aria-label={`${t("col.delete")}: ${name}`} data-testid={`collection-delete-${c.id}`}>
                    <IconTrash /> <span className="col-label">{t("col.delete")}</span>
                  </button>
                </div>
              </li>
            );
          })}
        </ol>
      )}

      <section className="col-auto" aria-labelledby="col-auto-title">
        <h2 id="col-auto-title">{t("col.auto_title")}</h2>
        <p className="muted">{t("col.auto_lead")}</p>
        <ul className="col-auto-list">
          {(["all", "new", "sale"] as const).map((k) => (
            <li key={k}>
              <span className="col-auto-chip">{t(`col.auto.${k}`)}</span>
              <span className="muted">{t(`col.auto.${k}_hint`)}</span>
            </li>
          ))}
        </ul>
      </section>

      {deleting && (
        <SmallConfirm
          title={fill(t("col.delete_title"), { name: collectionName(deleting, lang) })}
          lead={t("col.delete_lead")}
          confirmLabel={t("col.delete_confirm")}
          cancelLabel={t("col.cancel")}
          busy={busy}
          onConfirm={() => void confirmDelete()}
          onCancel={() => setDeleting(null)}
        />
      )}
    </div>
  );
}
