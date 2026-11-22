"use client";

import { useEffect, useMemo, useState } from "react";
import { IconPlus } from "@/components/product-wizard/wizardIcons";
import { ErrorBanner } from "@/components/States";
import { ApiError } from "@/lib/api";
import { collectionsApi, type CandidateItem, type CandidatesPage } from "@/lib/collections";
import "@/lib/collectionsText";
import { fill } from "@/lib/offerWizardText";
import { useTaxonomy } from "@/lib/taxonomy";
import { useLang, useT } from "@/lib/useLang";

const STATUSES = ["ACTIVE", "INACTIVE", "DRAFT"] as const;

/**
 * «اختيار المنتجات» (a full screen in the management window - never a modal):
 * search, category, status and stock filters, a page at a time, select one
 * by one or every product shown; products already in the collection are
 * marked and cannot be picked again. «إضافة» puts the chosen ones at the
 * END of the collection, in the order shown.
 */
export function CollectionPickerView({
  vendorId,
  id,
  onAdded,
}: {
  vendorId: string;
  id: string;
  onAdded: (count: number) => void;
}) {
  const t = useT();
  const lang = useLang();
  const taxonomy = useTaxonomy();
  const [q, setQ] = useState("");
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState("");
  const [status, setStatus] = useState("");
  const [stock, setStock] = useState("");
  const [page, setPage] = useState(1);
  const [data, setData] = useState<CandidatesPage | null>(null);
  const [selected, setSelected] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // the search waits for a pause in typing
  useEffect(() => {
    const h = setTimeout(() => {
      setQuery(q.trim());
      setPage(1);
    }, 300);
    return () => clearTimeout(h);
  }, [q]);

  useEffect(() => {
    let cancelled = false;
    const params: Record<string, string> = { page: String(page), page_size: "30" };
    if (query) params.q = query;
    if (category) params.category = category;
    if (status) params.status = status;
    if (stock) params.stock = stock;
    collectionsApi
      .candidates(vendorId, id, params)
      .then((r) => {
        if (!cancelled) {
          setData(r);
          setError(null);
        }
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof ApiError ? err.message : t("col.load_failed"));
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [vendorId, id, query, category, status, stock, page]);

  const categoryName = (code: string) => {
    const c = taxonomy.data?.categories.find((x) => x.code === code);
    return c ? (lang === "en" ? c.name_en || c.name_ar : c.name_ar) : code;
  };
  const pickable = useMemo(() => (data?.items ?? []).filter((x) => !x.in_collection), [data]);
  const allShownSelected = pickable.length > 0 && pickable.every((x) => selected.includes(x.offer_id));
  const room = 500 - (data?.in_collection ?? 0);
  const pages = data ? Math.max(1, Math.ceil(data.total / data.page_size)) : 1;

  function toggle(x: CandidateItem) {
    setSelected((s) => (s.includes(x.offer_id) ? s.filter((i) => i !== x.offer_id) : [...s, x.offer_id]));
  }
  function toggleShown() {
    setSelected((s) => (allShownSelected ? s.filter((i) => !pickable.some((x) => x.offer_id === i)) : [...s, ...pickable.map((x) => x.offer_id).filter((i) => !s.includes(i))]));
  }
  async function add() {
    if (selected.length === 0) return;
    setBusy(true);
    setError(null);
    try {
      const r = await collectionsApi.add(vendorId, id, selected);
      onAdded(r.added.length);
    } catch (err) {
      setError(err instanceof ApiError && err.code === "STORE_COLLECTION_FULL" ? t("col.full") : err instanceof ApiError ? err.message : t("col.save_failed"));
      setBusy(false);
    }
  }
  const title = (x: CandidateItem) => (lang === "en" && x.title_en ? x.title_en : x.title_ar);

  return (
    <div className="owner-catalog owner-embedded col-view col-picker" data-testid="collection-picker">
      <h1 className="page-title col-title">{t("pick.title")}</h1>
      {error && <ErrorBanner message={error} />}
      <div className="col-filters" role="search">
        <label className="col-filter col-filter-search">
          <span className="visually-hidden">{t("pick.search")}</span>
          <input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder={t("pick.search")} data-testid="picker-search" />
        </label>
        <label className="col-filter">
          <span>{t("pick.category")}</span>
          <select value={category} onChange={(e) => { setCategory(e.target.value); setPage(1); }} data-testid="picker-category">
            <option value="">{t("pick.category_all")}</option>
            {(data?.categories ?? []).map((c) => (
              <option key={c} value={c}>{categoryName(c)}</option>
            ))}
          </select>
        </label>
        <label className="col-filter">
          <span>{t("pick.status")}</span>
          <select value={status} onChange={(e) => { setStatus(e.target.value); setPage(1); }} data-testid="picker-status">
            <option value="">{t("pick.status_all")}</option>
            {STATUSES.map((s) => (
              <option key={s} value={s}>{t(`catalog.status.${s}`)}</option>
            ))}
          </select>
        </label>
        <label className="col-filter">
          <span>{t("pick.stock")}</span>
          <select value={stock} onChange={(e) => { setStock(e.target.value); setPage(1); }} data-testid="picker-stock">
            <option value="">{t("pick.stock_all")}</option>
            <option value="in">{t("pick.stock_in")}</option>
            <option value="out">{t("pick.stock_out")}</option>
          </select>
        </label>
      </div>

      <div className="col-picker-bar">
        <label className="col-check-all">
          <input type="checkbox" checked={allShownSelected} onChange={toggleShown} disabled={pickable.length === 0} data-testid="picker-select-page" />
          {t("pick.select_page")}
        </label>
        <span className="muted" role="status" aria-live="polite">{fill(t("pick.selected"), { n: selected.length })}</span>
      </div>

      {data === null && !error && <div className="skeleton" style={{ height: 200 }} />}
      {data && data.items.length === 0 && <p className="muted">{t("pick.none")}</p>}
      {data && data.items.length > 0 && (
        <ul className="col-pick-list">
          {data.items.map((x) => {
            const checked = x.in_collection || selected.includes(x.offer_id);
            return (
              <li key={x.offer_id} className={`col-pick${checked ? " is-on" : ""}${x.in_collection ? " is-in" : ""}`}>
                <label className="col-pick-label">
                  <input type="checkbox" checked={checked} disabled={x.in_collection} onChange={() => toggle(x)} data-testid={`picker-item-${x.offer_id}`} />
                  {x.image_url ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={x.image_url} alt="" className="col-item-thumb" />
                  ) : (
                    <span className="col-item-thumb col-thumb-empty" aria-hidden="true" />
                  )}
                  <span className="col-item-text">
                    <strong dir="auto">{title(x)}</strong>
                    <span className="col-pick-meta">
                      {x.categories.length > 0 && <span>{x.categories.map(categoryName).join("، ")}</span>}
                      <span className={`owner-status owner-status-${x.status.toLowerCase()}`}>{t(`catalog.status.${x.status}`)}</span>
                      {x.available <= 0 && <span className="col-item-off">{t("col.reason.sold_out")}</span>}
                      {x.in_collection && <span className="col-chip is-on">{t("pick.in_collection")}</span>}
                    </span>
                  </span>
                </label>
              </li>
            );
          })}
        </ul>
      )}
      {data && pages > 1 && (
        <nav className="col-pager" aria-label={fill(t("pick.page"), { p: page, n: pages })}>
          <button type="button" className="button-link wz-ghost" onClick={() => setPage((p) => Math.max(1, p - 1))} disabled={page <= 1}>{t("pick.prev")}</button>
          <span className="muted">{fill(t("pick.page"), { p: page, n: pages })}</span>
          <button type="button" className="button-link wz-ghost" onClick={() => setPage((p) => Math.min(pages, p + 1))} disabled={page >= pages}>{t("pick.next")}</button>
        </nav>
      )}

      <div className="col-picker-footer">
        {selected.length > room && <span className="col-error" role="alert">{t("col.full")}</span>}
        <button type="button" className="button owner-primary" onClick={() => void add()} disabled={busy || selected.length === 0 || selected.length > room} data-testid="picker-add">
          <IconPlus /> {fill(t("pick.add"), { n: selected.length })}
        </button>
      </div>
    </div>
  );
}
