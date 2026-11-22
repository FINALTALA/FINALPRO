"use client";

import { useEffect, useState } from "react";
import { IconCheck, IconImage } from "@/components/product-wizard/wizardIcons";
import { ErrorBanner } from "@/components/States";
import { ApiError } from "@/lib/api";
import { fill } from "@/lib/offerWizardText";
import { type PickerProduct, storeHomeApi } from "@/lib/storeHome";
import "@/lib/storeHomeText";
import { useLang, useT } from "@/lib/useLang";

/**
 * «اختيار المنتجات» for a home block: this store's products (not archived),
 * searchable, a page at a time; each says whether shoppers can see it now
 * (an unpublished or sold-out product can be chosen - it shows once it is
 * buyable again - and the block editor warns about it). `single`: choosing
 * one product (a button's destination) returns at once.
 */
export function HomeProductPicker({
  vendorId,
  selected,
  max,
  single = false,
  onToggle,
  onDone,
}: {
  vendorId: string;
  selected: string[];
  max: number;
  single?: boolean;
  onToggle: (p: PickerProduct) => void;
  onDone: () => void;
}) {
  const t = useT();
  const lang = useLang();
  const [query, setQuery] = useState("");
  const [debounced, setDebounced] = useState("");
  const [items, setItems] = useState<PickerProduct[] | null>(null);
  const [page, setPage] = useState(1);
  const [total, setTotal] = useState(0);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    const h = setTimeout(() => setDebounced(query.trim()), 300);
    return () => clearTimeout(h);
  }, [query]);
  useEffect(() => {
    let cancelled = false;
    storeHomeApi
      .products(vendorId, debounced, page)
      .then((r) => {
        if (cancelled) return;
        setTotal(r.total);
        setItems((prev) => (page === 1 || !prev ? r.items : [...prev, ...r.items]));
        setError(null);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof ApiError ? err.message : t("home.load_failed"));
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [vendorId, debounced, page]);
  const full = !single && selected.length >= max;
  return (
    <div className="shd-picker" data-testid="home-product-picker">
      <div className="shd-picker-head">
        <input
          type="search"
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setPage(1);
          }}
          placeholder={t("home.pick.search")}
          aria-label={t("home.pick.search")}
          data-testid="home-picker-search"
        />
        {!single && <span className="col-count" aria-live="polite">{fill(t("home.pick.chosen"), { n: selected.length })}</span>}
      </div>
      {full && <p className="shd-hint">{fill(t("home.pick.limit"), { max })}</p>}
      {error && <ErrorBanner message={error} />}
      {items === null && !error && <div className="skeleton" style={{ height: 160 }} />}
      {items && items.length === 0 && <p className="muted">{t("home.pick.empty")}</p>}
      {items && items.length > 0 && (
        <ul className="shd-picker-list">
          {items.map((p) => {
            const on = selected.includes(p.id);
            const name = (lang === "en" ? p.title_en : p.title_ar) || p.title_ar;
            return (
              <li key={p.id}>
                <label className={`shd-picker-item${on ? " is-on" : ""}`}>
                  <input
                    type={single ? "radio" : "checkbox"}
                    name={single ? "home-pick-one" : undefined}
                    checked={on}
                    disabled={!on && full}
                    onChange={() => {
                      onToggle(p);
                      if (single) onDone();
                    }}
                    data-testid={`home-pick-${p.id}`}
                  />
                  {p.image_url ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={p.image_url} alt="" className="col-thumb" />
                  ) : (
                    <span className="col-thumb col-thumb-empty" aria-hidden="true"><IconImage /></span>
                  )}
                  <span className="shd-picker-name">{name}</span>
                  {p.status !== "ok" && <span className="col-note is-warn">{t(`home.ref.${p.status}`)}</span>}
                  {on && <span className="shd-picker-on" aria-hidden="true"><IconCheck /></span>}
                </label>
              </li>
            );
          })}
        </ul>
      )}
      {items && items.length < total && (
        <button type="button" className="button button-secondary" onClick={() => setPage((n) => n + 1)}>
          {t("home.pick.more")}
        </button>
      )}
      {!single && (
        <div className="shd-picker-foot">
          <button type="button" className="button owner-primary" onClick={onDone} data-testid="home-picker-done">
            {t("home.done")}
          </button>
        </div>
      )}
    </div>
  );
}
