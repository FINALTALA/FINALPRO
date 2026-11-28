"use client";

import "@/lib/adminCatalogText";
import Link from "next/link";
import { FormEvent, useCallback, useEffect, useState } from "react";
import { EmptyState, ErrorBanner } from "@/components/States";
import { ApiError, apiFetch, newIdempotencyKey } from "@/lib/api";
import { isForbidden } from "@/lib/admin";
import { fillMp, mpError } from "@/lib/adminMarketplaceText";
import { useAdminGate } from "@/lib/useAdminGate";
import { useLang, useT } from "@/lib/useLang";

interface BrandRow {
  id: string;
  name: string;
}

interface DuplicateCandidate {
  id: string;
  name: string;
  similarity: number;
}

// Sprint 17b (FR-CAT-002/BL-CAT-002): the platform admin's brand list -
// create (with the backend's possible-duplicate WARNING, never a hard
// block), rename, and delete (the "No brand" sentinel row and any
// brand still referenced by a canonical product are rejected by the
// API, not hidden from the list). PLATFORM_ADMIN only.
export default function AdminBrandsPage() {
  const gate = useAdminGate("ADMIN");
  const lang = useLang();
  const t = useT();
  const [items, setItems] = useState<BrandRow[] | null>(null);
  // M-01: the failure itself is kept, so its message follows the UI language.
  const [loadFailure, setLoadFailure] = useState<unknown>(null);
  const error = loadFailure === null ? null : mpError(loadFailure, lang);
  const [forbidden, setForbidden] = useState(false);

  const load = useCallback(() => {
    apiFetch<BrandRow[]>("/brands")
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

  // --- create ---
  const [name, setName] = useState("");
  const [createBusy, setCreateBusy] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const [duplicates, setDuplicates] = useState<DuplicateCandidate[] | null>(null);

  async function createBrand(confirmDespiteDuplicate: boolean) {
    setCreateBusy(true);
    setCreateError(null);
    try {
      await apiFetch("/brands", {
        method: "POST",
        body: {
          name: name.trim(),
          ...(confirmDespiteDuplicate ? { confirm_despite_duplicate_warning: true } : {}),
        },
        idempotencyKey: newIdempotencyKey(
          confirmDespiteDuplicate ? "brand-create-confirm" : "brand-create",
        ),
      });
      setName("");
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
    if (!name.trim()) return;
    setDuplicates(null);
    createBrand(false);
  }

  // --- inline rename ---
  const [editId, setEditId] = useState<string | null>(null);
  const [editName, setEditName] = useState("");
  const [editBusy, setEditBusy] = useState(false);
  const [editError, setEditError] = useState<string | null>(null);
  // M-09: a rename gets the same possible-duplicate warning as create.
  const [editDuplicates, setEditDuplicates] = useState<DuplicateCandidate[] | null>(null);

  async function saveEdit(confirmDespiteDuplicate = false) {
    if (!editId) return;
    setEditBusy(true);
    setEditError(null);
    try {
      await apiFetch(`/brands/${editId}`, {
        method: "PATCH",
        body: {
          name: editName.trim(),
          ...(confirmDespiteDuplicate ? { confirm_despite_duplicate_warning: true } : {}),
        },
      });
      setEditId(null);
      setEditDuplicates(null);
      load();
    } catch (err) {
      if (err instanceof ApiError && err.code === "POSSIBLE_DUPLICATE") {
        setEditDuplicates((err.details as DuplicateCandidate[]) ?? []);
      } else {
        setEditDuplicates(null);
        setEditError(mpError(err, lang));
      }
    } finally {
      setEditBusy(false);
    }
  }

  // --- delete (two-step inline confirm) ---
  const [deleteConfirmId, setDeleteConfirmId] = useState<string | null>(null);
  const [deleteBusy, setDeleteBusy] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  async function confirmDelete(id: string) {
    setDeleteBusy(true);
    setDeleteError(null);
    try {
      await apiFetch(`/brands/${id}`, { method: "DELETE" });
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
        <div className="skeleton" style={{ height: 120, width: "100%", maxWidth: 800 }} />
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
      <div className="wide-shell" style={{ maxWidth: 800 }}>
        <div className="top-bar">
          <h1 className="page-title" style={{ margin: 0 }}>{t("mpa.br.title")}</h1>
          <Link href="/admin" className="button-link">{t("mpa.cat.dashboard")}</Link>
        </div>

        {error && <ErrorBanner message={error} />}

        <div className="card" style={{ maxWidth: "none", marginBottom: 16 }}>
          <h3 style={{ marginTop: 0 }}>{t("mpa.br.newTitle")}</h3>
          <form onSubmit={submitCreate}>
            <div className="field">
              <label htmlFor="brand-name">{t("mpa.cat.name")}</label>
              <input id="brand-name" value={name} disabled={createBusy} onChange={(e) => setName(e.target.value)} />
            </div>
            {createError && <ErrorBanner message={createError} />}
            {duplicates && duplicates.length > 0 && (
              <div className="warning-banner">
                <p style={{ marginTop: 0 }}>{t("mpa.br.duplicates")}</p>
                <ul style={{ margin: "0 0 10px", paddingInlineStart: 20 }}>
                  {duplicates.map((d) => (
                    <li key={d.id}>
                      {d.name} — {fillMp(t("mpa.cat.similarity"), { pct: (d.similarity * 100).toFixed(0) })}
                    </li>
                  ))}
                </ul>
                <button type="button" className="button" disabled={createBusy} onClick={() => createBrand(true)}>
                  {createBusy ? t("mpa.cat.creating") : t("mpa.cat.createAnyway")}
                </button>
              </div>
            )}
            <button className="button" type="submit" disabled={createBusy || !name.trim()}>
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
          <EmptyState title={t("mpa.br.empty")} message={t("mpa.br.emptyHint")} />
        )}
        {items && items.length > 0 && (
          <div className="card" style={{ maxWidth: "none" }}>
            {items.map((b) => (
              <div key={b.id} style={{ borderBottom: "1px solid var(--color-border)", padding: "10px 0" }}>
                {editId === b.id ? (
                  <div>
                    <div className="field">
                      <label>{t("mpa.cat.name")}</label>
                      <input value={editName} disabled={editBusy} onChange={(e) => setEditName(e.target.value)} />
                    </div>
                    {editError && <ErrorBanner message={editError} />}
                    {editDuplicates && editDuplicates.length > 0 && (
                      <div className="warning-banner" data-testid="brand-rename-duplicates">
                        <p style={{ marginTop: 0 }}>{t("mpa.br.duplicates")}</p>
                        <ul style={{ margin: "0 0 10px", paddingInlineStart: 20 }}>
                          {editDuplicates.map((d) => (
                            <li key={d.id}>
                              {d.name} — {fillMp(t("mpa.cat.similarity"), { pct: (d.similarity * 100).toFixed(0) })}
                            </li>
                          ))}
                        </ul>
                        <button type="button" className="button" disabled={editBusy} onClick={() => saveEdit(true)}>
                          {editBusy ? t("mpa.cat.saving") : t("mpa.cat.saveAnyway")}
                        </button>
                      </div>
                    )}
                    <div style={{ display: "flex", gap: 8 }}>
                      <button className="button" disabled={editBusy || !editName.trim()} onClick={() => saveEdit()}>
                        {editBusy ? t("mpa.cat.saving") : t("mpa.cat.save")}
                      </button>
                      <button className="button-link" disabled={editBusy} onClick={() => { setEditId(null); setEditDuplicates(null); }}>
                        {t("mpa.cat.cancel")}
                      </button>
                    </div>
                  </div>
                ) : (
                  <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10, flexWrap: "wrap" }}>
                    <strong>{b.name}</strong>
                    <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                      <button
                        className="button-link"
                        onClick={() => {
                          setEditId(b.id);
                          setEditName(b.name);
                          setEditError(null);
                          setEditDuplicates(null);
                        }}
                      >
                        {t("mpa.cat.edit")}
                      </button>
                      {deleteConfirmId === b.id ? (
                        <>
                          <button className="button-link" disabled={deleteBusy} onClick={() => confirmDelete(b.id)}>
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
                            setDeleteConfirmId(b.id);
                            setDeleteError(null);
                          }}
                        >
                          {t("mpa.cat.delete")}
                        </button>
                      )}
                    </div>
                  </div>
                )}
                {deleteConfirmId === b.id && deleteError && (
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
