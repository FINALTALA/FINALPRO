"use client";

import "@/lib/adminCatalogText";
import Link from "next/link";
import { FormEvent, useCallback, useEffect, useState } from "react";
import { EmptyState, ErrorBanner } from "@/components/States";
import { ApiError, apiFetch, newIdempotencyKey } from "@/lib/api";
import { isForbidden } from "@/lib/admin";
import { fillMp, mpError, mpReasonProblem } from "@/lib/adminMarketplaceText";
import { useAdminGate } from "@/lib/useAdminGate";
import { useLang, useT } from "@/lib/useLang";

interface CategoryRow {
  id: string;
  name_ar: string;
  name_en: string;
  parent_id: string | null;
  is_restricted: boolean;
  /** M-06: returned to platform admins only. */
  restriction_reason?: string | null;
}

interface DuplicateCandidate {
  id: string;
  name_ar: string;
  name_en: string;
  similarity: number;
}

type RestrictPanel = { id: string; mode: "restrict" | "unrestrict" } | null;

/** Pre-order flatten of the parent_id tree, each row paired with its depth. */
function flatten(items: CategoryRow[]): { row: CategoryRow; depth: number }[] {
  const byParent = new Map<string | null, CategoryRow[]>();
  for (const c of items) {
    const key = c.parent_id;
    byParent.set(key, [...(byParent.get(key) ?? []), c]);
  }
  const out: { row: CategoryRow; depth: number }[] = [];
  function visit(parentId: string | null, depth: number) {
    for (const c of byParent.get(parentId) ?? []) {
      out.push({ row: c, depth });
      visit(c.id, depth + 1);
    }
  }
  visit(null, 0);
  return out;
}

// Sprint 17b (FR-CAT-001/BL-CAT-001): the platform admin's category
// tree - create (with the backend's possible-duplicate WARNING, never
// a hard block - an "إنشاء رغم التشابه" button always resubmits with
// confirm_despite_duplicate_warning), rename/re-parent, restrict/
// unrestrict, and delete (blocked only while canonical products still
// reference the category). PLATFORM_ADMIN only.
export default function AdminCategoriesPage() {
  const gate = useAdminGate("ADMIN");
  const lang = useLang();
  const t = useT();
  const [items, setItems] = useState<CategoryRow[] | null>(null);
  // M-01: the failure itself is kept, so its message follows the UI language.
  const [loadFailure, setLoadFailure] = useState<unknown>(null);
  const error = loadFailure === null ? null : mpError(loadFailure, lang);
  const [forbidden, setForbidden] = useState(false);

  const load = useCallback(() => {
    apiFetch<CategoryRow[]>("/categories")
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
    if (gate.status === "ok") load();
  }, [gate.status, load]);

  // --- create form ---
  const [nameAr, setNameAr] = useState("");
  const [nameEn, setNameEn] = useState("");
  const [parentId, setParentId] = useState("");
  const [createBusy, setCreateBusy] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const [duplicates, setDuplicates] = useState<DuplicateCandidate[] | null>(null);

  async function createCategory(confirmDespiteDuplicate: boolean) {
    setCreateBusy(true);
    setCreateError(null);
    try {
      await apiFetch("/categories", {
        method: "POST",
        body: {
          name_ar: nameAr.trim(),
          name_en: nameEn.trim(),
          parent_id: parentId || undefined,
          ...(confirmDespiteDuplicate ? { confirm_despite_duplicate_warning: true } : {}),
        },
        idempotencyKey: newIdempotencyKey(
          confirmDespiteDuplicate ? "category-create-confirm" : "category-create",
        ),
      });
      setNameAr("");
      setNameEn("");
      setParentId("");
      setDuplicates(null);
      load();
    } catch (err) {
      if (err instanceof ApiError && err.code === "POSSIBLE_DUPLICATE") {
        setDuplicates((err.details as DuplicateCandidate[]) ?? []);
      } else {
        setCreateError(mpError(err, lang));
      }
    } finally {
      setCreateBusy(false);
    }
  }

  function submitCreate(e: FormEvent) {
    e.preventDefault();
    if (!nameAr.trim() || !nameEn.trim()) return;
    setDuplicates(null);
    createCategory(false);
  }

  // --- inline edit ---
  const [editId, setEditId] = useState<string | null>(null);
  const [eNameAr, setENameAr] = useState("");
  const [eNameEn, setENameEn] = useState("");
  const [eParentId, setEParentId] = useState("");
  const [editBusy, setEditBusy] = useState(false);
  const [editError, setEditError] = useState<string | null>(null);

  function openEdit(c: CategoryRow) {
    setEditId(c.id);
    setENameAr(c.name_ar);
    setENameEn(c.name_en);
    setEParentId(c.parent_id ?? "");
    setEditError(null);
  }

  // Excludes the category itself and its own descendants from the
  // parent-id choices, so the UI can never even offer a selection the
  // backend would reject as CATEGORY_CYCLE.
  function descendantIds(id: string): Set<string> {
    const ids = new Set<string>();
    const stack = [id];
    while (stack.length > 0) {
      const cur = stack.pop() as string;
      for (const c of items ?? []) {
        if (c.parent_id === cur && !ids.has(c.id)) {
          ids.add(c.id);
          stack.push(c.id);
        }
      }
    }
    return ids;
  }

  async function saveEdit() {
    if (!editId) return;
    setEditBusy(true);
    setEditError(null);
    try {
      await apiFetch(`/categories/${editId}`, {
        method: "PATCH",
        body: {
          name_ar: eNameAr.trim(),
          name_en: eNameEn.trim(),
          parent_id: eParentId || null,
        },
      });
      setEditId(null);
      load();
    } catch (err) {
      setEditError(mpError(err, lang));
    } finally {
      setEditBusy(false);
    }
  }

  // --- restrict / unrestrict ---
  const [restrictPanel, setRestrictPanel] = useState<RestrictPanel>(null);
  const [restrictReason, setRestrictReason] = useState("");
  const [restrictBusy, setRestrictBusy] = useState(false);
  const [restrictError, setRestrictError] = useState<string | null>(null);
  const restrictProblem = mpReasonProblem(restrictReason, lang);

  function openRestrict(id: string, mode: "restrict" | "unrestrict") {
    setRestrictPanel({ id, mode });
    setRestrictReason("");
    setRestrictError(null);
  }

  async function submitRestrict() {
    if (!restrictPanel) return;
    if (restrictPanel.mode === "restrict" && restrictProblem) return;
    setRestrictBusy(true);
    setRestrictError(null);
    try {
      await apiFetch(`/categories/${restrictPanel.id}/${restrictPanel.mode}`, {
        method: "POST",
        body: restrictPanel.mode === "restrict" ? { reason: restrictReason.trim() } : undefined,
        idempotencyKey: newIdempotencyKey(`category-${restrictPanel.mode}`),
      });
      setRestrictPanel(null);
      setRestrictReason("");
      load();
    } catch (err) {
      setRestrictError(mpError(err, lang));
    } finally {
      setRestrictBusy(false);
    }
  }

  // --- delete (two-step inline confirm - no window.confirm) ---
  const [deleteConfirmId, setDeleteConfirmId] = useState<string | null>(null);
  const [deleteBusy, setDeleteBusy] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  async function confirmDelete(id: string) {
    setDeleteBusy(true);
    setDeleteError(null);
    try {
      await apiFetch(`/categories/${id}`, { method: "DELETE" });
      setDeleteConfirmId(null);
      load();
    } catch (err) {
      setDeleteError(mpError(err, lang));
    } finally {
      setDeleteBusy(false);
    }
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

  const rows = items ? flatten(items) : [];

  return (
    <div className="page-shell">
      <div className="wide-shell" style={{ maxWidth: 1000 }}>
        <div className="top-bar">
          <h1 className="page-title" style={{ margin: 0 }}>{t("mpa.cg.title")}</h1>
          <Link href="/admin" className="button-link">{t("mpa.cat.dashboard")}</Link>
        </div>

        {error && <ErrorBanner message={error} />}

        <div className="card" style={{ maxWidth: "none", marginBottom: 16 }}>
          <h3 style={{ marginTop: 0 }}>{t("mpa.cg.newTitle")}</h3>
          <form onSubmit={submitCreate}>
            <div className="form-row">
              <div className="field">
                <label htmlFor="cat-name-ar">{t("mpa.cat.nameAr")}</label>
                <input id="cat-name-ar" value={nameAr} disabled={createBusy} onChange={(e) => setNameAr(e.target.value)} />
              </div>
              <div className="field">
                <label htmlFor="cat-name-en">{t("mpa.cat.nameEn")}</label>
                <input id="cat-name-en" value={nameEn} disabled={createBusy} onChange={(e) => setNameEn(e.target.value)} />
              </div>
            </div>
            <div className="field">
              <label htmlFor="cat-parent">{t("mpa.cg.parentOptional")}</label>
              <select id="cat-parent" value={parentId} disabled={createBusy} onChange={(e) => setParentId(e.target.value)}>
                <option value="">{t("mpa.cat.noParent")}</option>
                {rows.map(({ row, depth }) => (
                  <option key={row.id} value={row.id}>
                    {"— ".repeat(depth)}{lang === "en" ? row.name_en || row.name_ar : row.name_ar}
                  </option>
                ))}
              </select>
            </div>
            {createError && <ErrorBanner message={createError} />}
            {duplicates && duplicates.length > 0 && (
              <div className="warning-banner">
                <p style={{ marginTop: 0 }}>{t("mpa.cg.duplicates")}</p>
                <ul style={{ margin: "0 0 10px", paddingInlineStart: 20 }}>
                  {duplicates.map((d) => (
                    <li key={d.id}>
                      {d.name_ar} / {d.name_en} — {fillMp(t("mpa.cat.similarity"), { pct: (d.similarity * 100).toFixed(0) })}
                    </li>
                  ))}
                </ul>
                <button type="button" className="button" disabled={createBusy} onClick={() => createCategory(true)}>
                  {createBusy ? t("mpa.cat.creating") : t("mpa.cat.createAnyway")}
                </button>
              </div>
            )}
            <button className="button" type="submit" disabled={createBusy || !nameAr.trim() || !nameEn.trim()}>
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
          <EmptyState title={t("mpa.cg.empty")} message={t("mpa.cg.emptyHint")} />
        )}
        {items && items.length > 0 && (
          <div className="card" style={{ maxWidth: "none" }}>
            {rows.map(({ row, depth }) => (
              <div key={row.id} style={{ borderBottom: "1px solid var(--color-border)", padding: "10px 0" }}>
                {editId === row.id ? (
                  <div style={{ paddingInlineStart: depth * 20 }}>
                    <div className="form-row">
                      <div className="field">
                        <label>{t("mpa.cat.nameAr")}</label>
                        <input value={eNameAr} disabled={editBusy} onChange={(e) => setENameAr(e.target.value)} />
                      </div>
                      <div className="field">
                        <label>{t("mpa.cat.nameEn")}</label>
                        <input value={eNameEn} disabled={editBusy} onChange={(e) => setENameEn(e.target.value)} />
                      </div>
                    </div>
                    <div className="field">
                      <label>{t("mpa.cg.parent")}</label>
                      <select value={eParentId} disabled={editBusy} onChange={(e) => setEParentId(e.target.value)}>
                        <option value="">{t("mpa.cat.noParent")}</option>
                        {rows
                          .filter(({ row: r }) => r.id !== row.id && !descendantIds(row.id).has(r.id))
                          .map(({ row: r, depth: d }) => (
                            <option key={r.id} value={r.id}>
                              {"— ".repeat(d)}{lang === "en" ? r.name_en || r.name_ar : r.name_ar}
                            </option>
                          ))}
                      </select>
                    </div>
                    {editError && <ErrorBanner message={editError} />}
                    <div style={{ display: "flex", gap: 8 }}>
                      <button className="button" disabled={editBusy || !eNameAr.trim() || !eNameEn.trim()} onClick={saveEdit}>
                        {editBusy ? t("mpa.cat.saving") : t("mpa.cat.save")}
                      </button>
                      <button className="button-link" disabled={editBusy} onClick={() => setEditId(null)}>
                        {t("mpa.cat.cancel")}
                      </button>
                    </div>
                  </div>
                ) : (
                  <div
                    style={{
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "space-between",
                      gap: 10,
                      flexWrap: "wrap",
                      paddingInlineStart: depth * 20,
                    }}
                  >
                    <div>
                      <strong>{row.name_ar}</strong> <span className="muted">{row.name_en}</span>{" "}
                      {row.is_restricted && <span className="badge">{t("mpa.cat.restricted")}</span>}
                      {row.is_restricted && row.restriction_reason && (
                        <div className="muted" style={{ fontSize: 13, marginTop: 2 }} data-testid="category-restriction-reason">
                          {fillMp(t("mpa.cat.restrictReasonShown"), { reason: row.restriction_reason })}
                        </div>
                      )}
                    </div>
                    <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                      <button className="button-link" onClick={() => openEdit(row)}>
                        {t("mpa.cat.edit")}
                      </button>
                      {row.is_restricted ? (
                        <button className="button-link" onClick={() => openRestrict(row.id, "unrestrict")}>
                          {t("mpa.cat.unrestrict")}
                        </button>
                      ) : (
                        <button className="button-link" onClick={() => openRestrict(row.id, "restrict")}>
                          {t("mpa.cat.restrict")}
                        </button>
                      )}
                      {deleteConfirmId === row.id ? (
                        <>
                          <button className="button-link" disabled={deleteBusy} onClick={() => confirmDelete(row.id)}>
                            {deleteBusy ? t("mpa.cat.deleting") : t("mpa.cat.confirmDelete")}
                          </button>
                          <button className="button-link" disabled={deleteBusy} onClick={() => setDeleteConfirmId(null)}>
                            {t("mpa.cat.cancel")}
                          </button>
                        </>
                      ) : (
                        <button
                          className="button-link"
                          onClick={() => {
                            setDeleteConfirmId(row.id);
                            setDeleteError(null);
                          }}
                        >
                          {t("mpa.cat.delete")}
                        </button>
                      )}
                    </div>
                  </div>
                )}
                {restrictPanel?.id === row.id && (
                  <div style={{ marginTop: 10, paddingInlineStart: depth * 20 }}>
                    {restrictPanel.mode === "restrict" ? (
                      <div className="field">
                        <label>{t("mpa.cat.restrictReason")}</label>
                        <textarea
                          rows={3}
                          value={restrictReason}
                          disabled={restrictBusy}
                          onChange={(e) => setRestrictReason(e.target.value)}
                        />
                        <span className="muted">{restrictReason.trim().length} / 1000</span>
                        {restrictProblem && restrictReason.length > 0 && (
                          <span className="field-error">{restrictProblem}</span>
                        )}
                      </div>
                    ) : (
                      <p className="muted">{t("mpa.cg.unrestrictHint")}</p>
                    )}
                    {restrictError && <ErrorBanner message={restrictError} />}
                    <div style={{ display: "flex", gap: 8 }}>
                      <button
                        className="button"
                        disabled={restrictBusy || (restrictPanel.mode === "restrict" && restrictProblem !== null)}
                        onClick={submitRestrict}
                      >
                        {restrictBusy
                          ? t("mpa.cat.sending")
                          : restrictPanel.mode === "restrict"
                            ? t("mpa.cat.confirmRestrict")
                            : t("mpa.cat.confirmUnrestrict")}
                      </button>
                      <button className="button-link" disabled={restrictBusy} onClick={() => setRestrictPanel(null)}>
                        {t("mpa.cat.cancel")}
                      </button>
                    </div>
                  </div>
                )}
                {deleteConfirmId === row.id && deleteError && (
                  <div style={{ marginTop: 10 }}>
                    <ErrorBanner message={deleteError} />
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
