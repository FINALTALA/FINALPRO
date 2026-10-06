"use client";

import Link from "next/link";
import { FormEvent, useCallback, useEffect, useState } from "react";
import { EmptyState, ErrorBanner } from "@/components/States";
import { ApiError, apiFetch, newIdempotencyKey } from "@/lib/api";
import { adminErrorMessage, isForbidden } from "@/lib/admin";
import { useAdminGate } from "@/lib/useAdminGate";

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
  const [items, setItems] = useState<BrandRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [forbidden, setForbidden] = useState(false);

  const load = useCallback(() => {
    apiFetch<BrandRow[]>("/brands")
      .then((rows) => {
        setItems(rows);
        setError(null);
      })
      .catch((err) => {
        if (isForbidden(err)) setForbidden(true);
        setError(adminErrorMessage(err));
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
        setCreateError(adminErrorMessage(err));
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

  async function saveEdit() {
    if (!editId) return;
    setEditBusy(true);
    setEditError(null);
    try {
      await apiFetch(`/brands/${editId}`, {
        method: "PATCH",
        body: { name: editName.trim() },
      });
      setEditId(null);
      load();
    } catch (err) {
      setEditError(adminErrorMessage(err));
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
      setDeleteError(adminErrorMessage(err));
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
        <EmptyState title="هذه الصفحة لمدير المنصة فقط" actionHref="/account" actionLabel="حسابي" />
      </div>
    );
  }

  return (
    <div className="page-shell">
      <div className="wide-shell" style={{ maxWidth: 800 }}>
        <div className="top-bar">
          <h1 className="page-title" style={{ margin: 0 }}>العلامات التجارية</h1>
          <Link href="/admin" className="button-link">إدارة المنصة</Link>
        </div>

        {error && <ErrorBanner message={error} />}

        <div className="card" style={{ maxWidth: "none", marginBottom: 16 }}>
          <h3 style={{ marginTop: 0 }}>علامة تجارية جديدة</h3>
          <form onSubmit={submitCreate}>
            <div className="field">
              <label htmlFor="brand-name">الاسم</label>
              <input id="brand-name" value={name} disabled={createBusy} onChange={(e) => setName(e.target.value)} />
            </div>
            {createError && <ErrorBanner message={createError} />}
            {duplicates && duplicates.length > 0 && (
              <div className="warning-banner">
                <p style={{ marginTop: 0 }}>توجد علامات تجارية مشابهة بالفعل، تأكدي أنّ هذا ليس تكراراً:</p>
                <ul style={{ margin: "0 0 10px", paddingInlineStart: 20 }}>
                  {duplicates.map((d) => (
                    <li key={d.id}>
                      {d.name} — تشابه {(d.similarity * 100).toFixed(0)}٪
                    </li>
                  ))}
                </ul>
                <button type="button" className="button" disabled={createBusy} onClick={() => createBrand(true)}>
                  {createBusy ? "جارٍ الإنشاء..." : "إنشاء رغم التشابه"}
                </button>
              </div>
            )}
            <button className="button" type="submit" disabled={createBusy || !name.trim()}>
              {createBusy ? "جارٍ الإنشاء..." : "إنشاء"}
            </button>
          </form>
        </div>

        {!items && !error && (
          <div aria-busy="true" aria-label="جارٍ التحميل">
            <div className="skeleton" style={{ height: 56, width: "100%", marginBottom: 8 }} />
            <div className="skeleton" style={{ height: 56, width: "100%" }} />
          </div>
        )}
        {items && items.length === 0 && (
          <EmptyState title="لا توجد علامات تجارية بعد" message="أنشئي أول علامة تجارية من النموذج أعلاه." />
        )}
        {items && items.length > 0 && (
          <div className="card" style={{ maxWidth: "none" }}>
            {items.map((b) => (
              <div key={b.id} style={{ borderBottom: "1px solid var(--color-border)", padding: "10px 0" }}>
                {editId === b.id ? (
                  <div>
                    <div className="field">
                      <label>الاسم</label>
                      <input value={editName} disabled={editBusy} onChange={(e) => setEditName(e.target.value)} />
                    </div>
                    {editError && <ErrorBanner message={editError} />}
                    <div style={{ display: "flex", gap: 8 }}>
                      <button className="button" disabled={editBusy || !editName.trim()} onClick={saveEdit}>
                        {editBusy ? "جارٍ الحفظ..." : "حفظ"}
                      </button>
                      <button className="button-link" disabled={editBusy} onClick={() => setEditId(null)}>
                        إلغاء
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
                        }}
                      >
                        تعديل
                      </button>
                      {deleteConfirmId === b.id ? (
                        <>
                          <button className="button-link" disabled={deleteBusy} onClick={() => confirmDelete(b.id)}>
                            {deleteBusy ? "جارٍ الحذف..." : "تأكيد الحذف"}
                          </button>
                          <button className="button-link" disabled={deleteBusy} onClick={() => setDeleteConfirmId(null)}>
                            إلغاء
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
                          حذف
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
