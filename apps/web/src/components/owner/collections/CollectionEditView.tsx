"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { IconArrowDown, IconArrowUp, IconClose, IconGrip, IconImage, IconPlus, IconUpload } from "@/components/product-wizard/wizardIcons";
import { ErrorBanner } from "@/components/States";
import { ApiError, uploadVendorImage } from "@/lib/api";
import { collectionsApi, notShownReason, type CollectionDetail, type CollectionItem } from "@/lib/collections";
import "@/lib/collectionsText";
import { fill } from "@/lib/offerWizardText";
import { showToast } from "@/lib/toast";
import { useLang, useT } from "@/lib/useLang";

const PAGE = 50;

/**
 * Create / edit one collection (it replaces the management window's
 * content; «رجوع» is the window's). The Arabic name is required, the
 * English one and the cover optional; visible or hidden. An existing
 * collection lists its products in the owner's order - drag (desktop) or
 * arrows (keyboard, phone) to move, ✕ to take one out - and says which
 * ones shoppers do not see and why. «إضافة منتجات» opens the picker in the
 * same window.
 */
export function CollectionEditView({
  vendorId,
  id,
  onSaved,
  onPick,
}: {
  vendorId: string;
  id: string | null;
  /** After a successful save (create or edit): back to «مجموعات المتجر» in the same window. */
  onSaved: () => void;
  onPick: (id: string, name: string) => void;
}) {
  const t = useT();
  const lang = useLang();
  const [nameAr, setNameAr] = useState("");
  const [nameEn, setNameEn] = useState("");
  const [cover, setCover] = useState<string | null>(null);
  const [visible, setVisible] = useState(true);
  const [detail, setDetail] = useState<CollectionDetail | null>(null);
  const [items, setItems] = useState<CollectionItem[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [nameError, setNameError] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [dragId, setDragId] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  // pages of PAGE products (the API serves at most 100 a page): "show more"
  // loads the next page; a reload after a change reloads the pages shown.
  const load = useCallback(
    (pages = 1) => {
      if (!id) return;
      void (async () => {
        try {
          const all: CollectionItem[] = [];
          let last: CollectionDetail | null = null;
          for (let p = 1; p <= pages; p += 1) {
            last = await collectionsApi.detail(vendorId, id, p, PAGE);
            all.push(...last.items);
            if (all.length >= last.product_count) break;
          }
          if (!last) return;
          setDetail(last);
          setItems(all);
          setNameAr(last.name_ar);
          setNameEn(last.name_en ?? "");
          setCover(last.cover_url);
          setVisible(last.visible);
        } catch (err) {
          setError(err instanceof ApiError ? err.message : t("col.load_failed"));
        }
      })();
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [vendorId, id],
  );
  useEffect(() => {
    load();
  }, [load]);

  async function upload(file: File | undefined) {
    if (!file) return;
    setBusy(true);
    try {
      const r = await uploadVendorImage(vendorId, file);
      setCover(r.url);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t("col.save_failed"));
    } finally {
      setBusy(false);
    }
  }

  async function save() {
    if (!nameAr.trim()) {
      setNameError(true);
      return;
    }
    setNameError(false);
    setBusy(true);
    setError(null);
    const body = { name_ar: nameAr.trim(), name_en: nameEn.trim() || null, cover_url: cover, visible };
    try {
      if (id) await collectionsApi.update(vendorId, id, body);
      else await collectionsApi.create(vendorId, body);
      // a small temporary message at the top, then the list - where the
      // collection now is, in its place
      showToast(t("col.saved"));
      onSaved();
    } catch (err) {
      // stays here, with what went wrong
      setError(err instanceof ApiError ? err.message : t("col.save_failed"));
      setBusy(false);
    }
  }

  async function moveTo(item: CollectionItem, position: number) {
    if (!id || position < 0 || position >= (detail?.product_count ?? 0)) return;
    const next = items.filter((x) => x.offer_id !== item.offer_id);
    next.splice(Math.min(position, next.length), 0, item);
    setItems(next);
    try {
      await collectionsApi.move(vendorId, id, item.offer_id, position);
      setNotice(fill(t("col.moved"), { name: title(item), n: position + 1 }));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t("col.save_failed"));
    }
    load(Math.max(1, Math.ceil(items.length / PAGE)));
  }
  async function removeItem(item: CollectionItem) {
    if (!id) return;
    setItems((xs) => xs.filter((x) => x.offer_id !== item.offer_id));
    try {
      await collectionsApi.removeProducts(vendorId, id, [item.offer_id]);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t("col.save_failed"));
    }
    load(Math.max(1, Math.ceil(items.length / PAGE)));
  }
  const title = (x: { title_ar: string; title_en: string }) => (lang === "en" && x.title_en ? x.title_en : x.title_ar);
  const shownName = nameAr.trim() || t("col.new_title");

  return (
    <div className="owner-catalog owner-embedded col-view col-edit-view" data-testid="collection-edit">
      <h1 className="page-title col-title">{id ? shownName : t("col.new_title")}</h1>
      {error && <ErrorBanner message={error} />}
      <p className="visually-hidden" role="status" aria-live="polite">{notice}</p>

      <section className="owner-card col-form" aria-label={t("col.edit_title")}>
        <div className="col-field">
          <label htmlFor="col-name-ar">
            {t("col.name_ar")} <span className="col-req" aria-hidden="true">*</span>
          </label>
          <input
            id="col-name-ar"
            value={nameAr}
            onChange={(e) => setNameAr(e.target.value)}
            maxLength={80}
            dir="rtl"
            lang="ar"
            required
            aria-invalid={nameError}
            aria-describedby={nameError ? "col-name-ar-error" : undefined}
            data-testid="collection-name-ar"
          />
          {nameError && <p id="col-name-ar-error" className="col-error" role="alert">{t("col.name_ar_required")}</p>}
        </div>
        <div className="col-field">
          <label htmlFor="col-name-en">
            {t("col.name_en")} <span className="muted">({t("col.optional")})</span>
          </label>
          <input id="col-name-en" value={nameEn} onChange={(e) => setNameEn(e.target.value)} maxLength={80} dir="ltr" lang="en" data-testid="collection-name-en" />
        </div>
        <div className="col-field">
          <span className="col-label-text" id="col-cover-label">{t("col.cover")}</span>
          <div className="col-cover" aria-labelledby="col-cover-label">
            {cover ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={cover} alt={fill(t("col.cover_alt"), { name: shownName })} className="col-cover-img" />
            ) : (
              <span className="col-cover-img col-thumb-empty" aria-hidden="true"><IconImage /></span>
            )}
            <div className="col-cover-tools">
              <span className="muted">{t("col.cover_hint")}</span>
              <span className="col-cover-buttons">
                <button type="button" className="button-link owner-secondary" onClick={() => fileRef.current?.click()} disabled={busy} data-testid="collection-cover-upload">
                  <IconUpload /> {cover ? t("col.cover_change") : t("col.cover_upload")}
                </button>
                {cover && (
                  <button type="button" className="button-link wz-ghost" onClick={() => setCover(null)} disabled={busy}>
                    {t("col.cover_remove")}
                  </button>
                )}
              </span>
              <input ref={fileRef} type="file" accept="image/jpeg,image/png,image/webp,image/gif" className="visually-hidden" tabIndex={-1} onChange={(e) => void upload(e.target.files?.[0])} data-testid="collection-cover-file" />
            </div>
          </div>
        </div>
        <fieldset className="col-field col-visibility">
          <legend>{t("col.visibility")}</legend>
          <label className={`col-choice${visible ? " is-on" : ""}`}>
            <input type="radio" name="col-visible" checked={visible} onChange={() => setVisible(true)} data-testid="collection-visible" /> {t("col.visible_option")}
          </label>
          <label className={`col-choice${!visible ? " is-on" : ""}`}>
            <input type="radio" name="col-visible" checked={!visible} onChange={() => setVisible(false)} data-testid="collection-hidden" /> {t("col.hidden_option")}
          </label>
        </fieldset>
        <div className="col-form-actions">
          <button type="button" className="button owner-primary" onClick={() => void save()} disabled={busy} data-testid="collection-save">
            {busy ? t("col.saving") : id ? t("col.save") : t("col.create")}
          </button>
        </div>
      </section>

      {id && detail && (
        <section className="owner-card col-products" aria-labelledby="col-products-title">
          <div className="col-products-head">
            <h2 id="col-products-title">
              {t("col.products_title")} <span className="wz-start-count">{detail.product_count}</span>
            </h2>
            <button type="button" className="button-link owner-secondary" onClick={() => onPick(id, shownName)} disabled={detail.product_count >= detail.limit} data-testid="collection-add-products">
              <IconPlus /> {t("col.add_products")}
            </button>
          </div>
          <p className="muted col-products-sub">
            {fill(t("col.shown"), { n: detail.shopper_count })} · {t("col.limit_note")}
          </p>
          {!detail.shown_to_shoppers && (
            <p className={`col-note${detail.visible ? " is-warn" : ""}`} data-testid="collection-edit-note">
              {detail.visible ? t("col.not_shown_empty") : t("col.not_shown_hidden")}
            </p>
          )}
          {items.length === 0 ? (
            <p className="muted">{t("col.no_products")}</p>
          ) : (
            <ol className="col-items">
              {items.map((item, i) => {
                const reason = notShownReason(item);
                const name = title(item);
                return (
                  <li
                    key={item.offer_id}
                    className={`col-item${dragId === item.offer_id ? " is-dragging" : ""}${reason ? " is-off" : ""}`}
                    draggable
                    onDragStart={(e) => {
                      setDragId(item.offer_id);
                      e.dataTransfer.effectAllowed = "move";
                    }}
                    onDragEnd={() => setDragId(null)}
                    onDragOver={(e) => {
                      if (dragId) e.preventDefault();
                    }}
                    onDrop={(e) => {
                      e.preventDefault();
                      const moved = items.find((x) => x.offer_id === dragId);
                      setDragId(null);
                      if (moved && moved.offer_id !== item.offer_id) void moveTo(moved, i);
                    }}
                    data-testid={`collection-item-${item.offer_id}`}
                  >
                    <span className="col-grip" aria-hidden="true"><IconGrip /></span>
                    <span className="col-pos" aria-hidden="true">{i + 1}</span>
                    {item.image_url ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img src={item.image_url} alt="" className="col-item-thumb" />
                    ) : (
                      <span className="col-item-thumb col-thumb-empty" aria-hidden="true" />
                    )}
                    <span className="col-item-text">
                      <strong dir="auto">{name}</strong>
                      {reason && (
                        <span className="col-item-off">
                          {t("col.product_not_shown")} · {t(`col.reason.${reason}`)}
                        </span>
                      )}
                    </span>
                    <span className="col-arrows">
                      <button type="button" className="col-icon-btn" onClick={() => void moveTo(item, i - 1)} disabled={i === 0} aria-label={fill(t("col.move_up"), { name })} title={fill(t("col.move_up"), { name })}>
                        <IconArrowUp />
                      </button>
                      <button type="button" className="col-icon-btn" onClick={() => void moveTo(item, i + 1)} disabled={i === detail.product_count - 1} aria-label={fill(t("col.move_down"), { name })} title={fill(t("col.move_down"), { name })}>
                        <IconArrowDown />
                      </button>
                      <button type="button" className="col-icon-btn col-remove" onClick={() => void removeItem(item)} aria-label={fill(t("col.remove_product"), { name })} title={fill(t("col.remove_product"), { name })} data-testid={`collection-remove-${item.offer_id}`}>
                        <IconClose />
                      </button>
                    </span>
                  </li>
                );
              })}
            </ol>
          )}
          {items.length < detail.product_count && (
            <button type="button" className="button-link wz-ghost col-more" onClick={() => load(Math.ceil(items.length / PAGE) + 1)}>
              {t("col.more")}
            </button>
          )}
        </section>
      )}
    </div>
  );
}
