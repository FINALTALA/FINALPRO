"use client";

import { useEffect, useRef, useState } from "react";
import { ApiError } from "@/lib/api";
import { collectionName, collectionsApi, type StoreCollection } from "@/lib/collections";
import "@/lib/collectionsText";
import { showToast } from "@/lib/toast";
import { useLang, useT } from "@/lib/useLang";

/**
 * A product's «المجموعات» (optional): the store's own collections it is in.
 *
 *  - "direct" (the owner's product page, the edit wizard): saved straight
 *    away with «حفظ» - not through the edit draft - and audited by the API;
 *  - "draft" (the new-product wizard): the chosen ids go into the draft
 *    (`value` / `onChange`) and the product joins them when it is published.
 *
 * A collection the product joins puts it LAST. Never changes its category.
 */
export function OfferCollectionsField({
  vendorId,
  offerId,
  mode,
  value,
  onChange,
  onManage,
  manageHref,
  onSaved,
  onLoaded,
}: {
  vendorId: string;
  offerId?: string | null;
  mode: "direct" | "draft";
  value?: string[];
  onChange?: (ids: string[]) => void;
  /** Opens «مجموعات المتجر» in the same management window. */
  onManage?: () => void;
  /** Or a link to it (outside the window). */
  manageHref?: string;
  /** Its own screen: after a successful save (a small message at the top, then back). */
  onSaved?: () => void;
  /** The store's collections once loaded (the wizard names them after publishing). */
  onLoaded?: (collections: StoreCollection[]) => void;
}) {
  const t = useT();
  const lang = useLang();
  const [collections, setCollections] = useState<StoreCollection[] | null>(null);
  const [chosen, setChosen] = useState<string[]>([]);
  const [saved, setSaved] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const onLoadedRef = useRef(onLoaded);
  useEffect(() => {
    onLoadedRef.current = onLoaded;
  }, [onLoaded]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const [list, mine] = await Promise.all([
          collectionsApi.list(vendorId),
          mode === "direct" && offerId ? collectionsApi.ofOffer(vendorId, offerId) : Promise.resolve(null),
        ]);
        if (cancelled) return;
        setCollections(list);
        onLoadedRef.current?.(list);
        if (mine) {
          setChosen(mine.section_ids);
          setSaved(mine.section_ids);
        }
      } catch {
        if (!cancelled) setCollections([]);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [vendorId, offerId, mode]);

  // a draft's choice IS the draft's value (no copy kept here)
  const current = mode === "draft" ? (value ?? []) : chosen;

  function toggle(id: string) {
    const next = current.includes(id) ? current.filter((x) => x !== id) : [...current, id];
    setMessage(null);
    if (mode === "draft") onChange?.(next);
    else setChosen(next);
  }
  async function save() {
    if (!offerId) return;
    setBusy(true);
    try {
      const r = await collectionsApi.setOfOffer(vendorId, offerId, chosen);
      setSaved(r.section_ids);
      if (onSaved) {
        showToast(t("offer.collections_saved"));
        onSaved();
        return;
      }
      setMessage({ ok: true, text: t("offer.collections_saved") });
    } catch (err) {
      setMessage({ ok: false, text: err instanceof ApiError ? err.message : t("col.save_failed") });
    } finally {
      setBusy(false);
    }
  }
  const dirty = mode === "direct" && (chosen.length !== saved.length || chosen.some((x) => !saved.includes(x)));

  return (
    <fieldset className="offer-collections" data-testid="offer-collections">
      <legend>{t("offer.collections")}</legend>
      <p className="muted offer-collections-hint">
        {t("offer.collections_hint")}
        {mode === "direct" && <> {t("offer.collections_direct")}</>}
      </p>
      {collections === null ? (
        <div className="skeleton" style={{ height: 36 }} />
      ) : collections.length === 0 ? (
        <p className="muted">{t("offer.collections_none")}</p>
      ) : (
        <ul className="offer-collections-list">
          {collections.map((c) => {
            const on = current.includes(c.id);
            return (
              <li key={c.id}>
                <label className={`offer-collection${on ? " is-on" : ""}`}>
                  <input type="checkbox" checked={on} onChange={() => toggle(c.id)} data-testid={`offer-collection-${c.id}`} />
                  <span>{collectionName(c, lang)}</span>
                  {!c.visible && <span className="col-chip is-off">{t("col.hidden")}</span>}
                </label>
              </li>
            );
          })}
        </ul>
      )}
      <div className="offer-collections-actions">
        {mode === "direct" && (
          <button type="button" className="button-link owner-secondary" onClick={() => void save()} disabled={busy || !dirty} data-testid="offer-collections-save">
            {busy ? t("col.saving") : t("col.save")}
          </button>
        )}
        {onManage ? (
          <button type="button" className="owner-quiet-link" onClick={onManage}>
            {t("offer.collections_manage")}
          </button>
        ) : manageHref ? (
          <a href={manageHref} className="owner-quiet-link">{t("offer.collections_manage")}</a>
        ) : null}
        {message && (
          <span className={message.ok ? "muted" : "col-error"} role={message.ok ? "status" : "alert"}>
            {message.text}
          </span>
        )}
      </div>
    </fieldset>
  );
}
