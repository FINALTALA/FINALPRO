"use client";

import "@/lib/adminCatalogText";
import Link from "next/link";
import { FormEvent, useCallback, useEffect, useState } from "react";
import { EmptyState, ErrorBanner } from "@/components/States";
import { ApiError, apiFetch, newIdempotencyKey } from "@/lib/api";
import { isForbidden } from "@/lib/admin";
import { fillMp, mpError, mpLabel } from "@/lib/adminMarketplaceText";
import { useAdminGate } from "@/lib/useAdminGate";
import { useLang, useT } from "@/lib/useLang";

interface CanonicalProductRow {
  id: string;
  brand_id: string;
  category_id: string;
  model_name: string;
  status: string;
  canonical_name_ar: string | null;
  canonical_name_en: string | null;
  is_restricted: boolean;
  merged_into_id: string | null;
}

interface BrandRow {
  id: string;
  name: string;
}

interface CategoryRow {
  id: string;
  name_ar: string;
  name_en?: string;
}

interface DuplicateCandidate {
  id: string;
  model_name: string;
  similarity: number;
}

// Sprint 17b (FR-MATCH-008/BL-MATCH-001): the platform admin's
// canonical-product list. Every new product starts life at DRAFT (the
// API decides that, not this form) - create here only takes brand/
// category/model name, with the same possible-duplicate WARNING
// pattern as categories/brands, plus a real blocking error when the
// chosen category is restricted. PLATFORM_ADMIN only.
export default function AdminCanonicalProductsPage() {
  const gate = useAdminGate("ADMIN");
  const lang = useLang();
  const t = useT();
  const [items, setItems] = useState<CanonicalProductRow[] | null>(null);
  const [brands, setBrands] = useState<BrandRow[]>([]);
  const [categories, setCategories] = useState<CategoryRow[]>([]);
  // M-01: the failure itself is kept, so its message follows the UI language.
  const [loadFailure, setLoadFailure] = useState<unknown>(null);
  const error = loadFailure === null ? null : mpError(loadFailure, lang);
  const [forbidden, setForbidden] = useState(false);

  const load = useCallback(() => {
    apiFetch<CanonicalProductRow[]>("/canonical-products")
      .then((rows) => {
        setItems(rows);
        setLoadFailure(null);
      })
      .catch((err) => {
        if (isForbidden(err)) setForbidden(true);
        setLoadFailure(err);
      });
  }, []);

  useEffect(() => {
    if (gate.status !== "ok") return;
    load();
    apiFetch<BrandRow[]>("/brands").then(setBrands).catch(() => {});
    apiFetch<CategoryRow[]>("/categories").then(setCategories).catch(() => {});
  }, [gate.status, load]);

  const brandName = (id: string) => brands.find((b) => b.id === id)?.name ?? "—";
  const categoryName = (id: string) => {
    const c = categories.find((x) => x.id === id);
    return (lang === "en" ? c?.name_en || c?.name_ar : c?.name_ar) ?? "—";
  };

  // --- create ---
  const [brandId, setBrandId] = useState("");
  const [categoryId, setCategoryId] = useState("");
  const [modelName, setModelName] = useState("");
  const [createBusy, setCreateBusy] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const [duplicates, setDuplicates] = useState<DuplicateCandidate[] | null>(null);

  async function createProduct(confirmDespiteDuplicate: boolean) {
    setCreateBusy(true);
    setCreateError(null);
    try {
      await apiFetch("/canonical-products", {
        method: "POST",
        body: {
          brand_id: brandId,
          category_id: categoryId,
          model_name: modelName.trim(),
          ...(confirmDespiteDuplicate ? { confirm_despite_duplicate_warning: true } : {}),
        },
        idempotencyKey: newIdempotencyKey(
          confirmDespiteDuplicate ? "canonical-product-create-confirm" : "canonical-product-create",
        ),
      });
      setModelName("");
      setDuplicates(null);
      load();
    } catch (err) {
      if (err instanceof ApiError && err.code === "POSSIBLE_DUPLICATE") {
        setDuplicates((err.details as DuplicateCandidate[]) ?? []);
      } else {
        // CATEGORY_RESTRICTED (and anything else) is a real blocking
        // error here, never shown as an overridable warning.
        setCreateError(mpError(err, lang));
      }
    } finally {
      setCreateBusy(false);
    }
  }

  function submitCreate(e: FormEvent) {
    e.preventDefault();
    if (!brandId || !categoryId || !modelName.trim()) return;
    setDuplicates(null);
    createProduct(false);
  }

  if (gate.status === "loading") {
    return (
      <div className="page-shell">
        <div className="skeleton" style={{ height: 120, width: "100%", maxWidth: 1000 }} />
      </div>
    );
  }
  if (gate.status === "forbidden" || forbidden) {
    return (
      <div className="page-shell">
        <EmptyState title={t("mpa.cat.forbidden")} actionHref="/account" actionLabel={t("mpa.cat.myAccount")} />
      </div>
    );
  }

  return (
    <div className="page-shell">
      <div className="wide-shell" style={{ maxWidth: 1000 }}>
        <div className="top-bar">
          <h1 className="page-title" style={{ margin: 0 }}>{t("mpa.cp.title")}</h1>
          <Link href="/admin" className="button-link">{t("mpa.cat.dashboard")}</Link>
        </div>

        {error && <ErrorBanner message={error} />}

        <div className="card" style={{ maxWidth: "none", marginBottom: 16 }}>
          <h3 style={{ marginTop: 0 }}>{t("mpa.cp.newTitle")}</h3>
          <form onSubmit={submitCreate}>
            <div className="form-row">
              <div className="field">
                <label htmlFor="cp-brand">{t("mpa.cat.brand")}</label>
                <select id="cp-brand" value={brandId} disabled={createBusy} onChange={(e) => setBrandId(e.target.value)}>
                  <option value="">{t("mpa.cat.chooseBrand")}</option>
                  {brands.map((b) => (
                    <option key={b.id} value={b.id}>{b.name}</option>
                  ))}
                </select>
              </div>
              <div className="field">
                <label htmlFor="cp-category">{t("mpa.cat.category")}</label>
                <select id="cp-category" value={categoryId} disabled={createBusy} onChange={(e) => setCategoryId(e.target.value)}>
                  <option value="">{t("mpa.cat.chooseCategory")}</option>
                  {categories.map((c) => (
                    <option key={c.id} value={c.id}>{lang === "en" ? c.name_en || c.name_ar : c.name_ar}</option>
                  ))}
                </select>
              </div>
            </div>
            <div className="field">
              <label htmlFor="cp-model">{t("mpa.cp.modelName")}</label>
              <input id="cp-model" value={modelName} disabled={createBusy} onChange={(e) => setModelName(e.target.value)} />
            </div>
            {createError && <ErrorBanner message={createError} />}
            {duplicates && duplicates.length > 0 && (
              <div className="warning-banner">
                <p style={{ marginTop: 0 }}>{t("mpa.cp.duplicates")}</p>
                <ul style={{ margin: "0 0 10px", paddingInlineStart: 20 }}>
                  {duplicates.map((d) => (
                    <li key={d.id}>
                      {d.model_name} — {fillMp(t("mpa.cat.similarity"), { pct: (d.similarity * 100).toFixed(0) })}
                    </li>
                  ))}
                </ul>
                <button type="button" className="button" disabled={createBusy} onClick={() => createProduct(true)}>
                  {createBusy ? t("mpa.cat.creating") : t("mpa.cat.createAnyway")}
                </button>
              </div>
            )}
            <button className="button" type="submit" disabled={createBusy || !brandId || !categoryId || !modelName.trim()}>
              {createBusy ? t("mpa.cat.creating") : t("mpa.cat.create")}
            </button>
          </form>
        </div>

        {!items && !error && (
          <div aria-busy="true" aria-label={t("mpa.cat.loading")}>
            <div className="skeleton" style={{ height: 56, width: "100%", marginBottom: 8 }} />
            <div className="skeleton" style={{ height: 56, width: "100%" }} />
          </div>
        )}
        {items && items.length === 0 && (
          <EmptyState title={t("mpa.cp.empty")} message={t("mpa.cp.emptyHint")} />
        )}
        {items && items.length > 0 && (
          <div style={{ overflowX: "auto" }}>
            <table className="data-table">
              <thead>
                <tr>
                  <th>{t("mpa.cp.colModel")}</th>
                  <th>{t("mpa.cat.brand")}</th>
                  <th>{t("mpa.cat.category")}</th>
                  <th>{t("mpa.cp.colStatus")}</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {items.map((p) => (
                  <tr key={p.id}>
                    <td>
                      {(lang === "en" ? p.canonical_name_en : p.canonical_name_ar) ?? p.model_name}
                      {p.is_restricted && <span className="badge" style={{ marginInlineStart: 8 }}>{t("mpa.cat.restricted")}</span>}
                    </td>
                    <td>{brandName(p.brand_id)}</td>
                    <td>{categoryName(p.category_id)}</td>
                    <td>
                      <span className={`badge${p.status === "PUBLISHED" ? " badge-active" : ""}`}>
                        {mpLabel(lang, "canonicalStatus", p.status)}
                      </span>
                    </td>
                    <td>
                      <Link className="button-link" href={`/admin/canonical-products/${p.id}`}>{t("mpa.cp.details")}</Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
