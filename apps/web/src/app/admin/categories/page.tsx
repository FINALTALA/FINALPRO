"use client";

import Link from "next/link";
import { FormEvent, useCallback, useEffect, useState } from "react";
import { EmptyState, ErrorBanner } from "@/components/States";
import { ApiError, apiFetch, newIdempotencyKey } from "@/lib/api";
import { adminErrorMessage, isForbidden, reasonProblem } from "@/lib/admin";
import { useAdminGate } from "@/lib/useAdminGate";

interface CategoryRow {
  id: string;
  name_ar: string;
  name_en: string;
  parent_id: string | null;
  is_restricted: boolean;
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
  const [items, setItems] = useState<CategoryRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [forbidden, setForbidden] = useState(false);

  const load = useCallback(() => {
    apiFetch<CategoryRow[]>("/categories")
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
        setCreateError(adminErrorMessage(err));
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
      setEditError(adminErrorMessage(err));
    } finally {
      setEditBusy(false);
    }
  }

  // --- restrict / unrestrict ---
  const [restrictPanel, setRestrictPanel] = useState<RestrictPanel>(null);
  const [restrictReason, setRestrictReason] = useState("");
  const [restrictBusy, setRestrictBusy] = useState(false);
  const [restrictError, setRestrictError] = useState<string | null>(null);
  const restrictProblem = reasonProblem(restrictReason);

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
      setRestrictError(adminErrorMessage(err));
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
      setDeleteError(adminErrorMessage(err));
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
        <EmptyState title="هذه الصفحة لمدير المنصة فقط" actionHref="/account" actionLabel="حسابي" />
      </div>
    );
  }

  const rows = items ? flatten(items) : [];

  return (
    <div className="page-shell">
      <div className="wide-shell" style={{ maxWidth: 1000 }}>
        <div className="top-bar">
          <h1 className="page-title" style={{ margin: 0 }}>التصنيفات</h1>
          <Link href="/admin" className="button-link">إدارة المنصة</Link>
        </div>

        {error && <ErrorBanner message={error} />}

        <div className="card" style={{ maxWidth: "none", marginBottom: 16 }}>
          <h3 style={{ marginTop: 0 }}>تصنيف جديد</h3>
          <form onSubmit={submitCreate}>
            <div className="form-row">
              <div className="field">
                <label htmlFor="cat-name-ar">الاسم بالعربية</label>
                <input id="cat-name-ar" value={nameAr} disabled={createBusy} onChange={(e) => setNameAr(e.target.value)} />
              </div>
              <div className="field">
                <label htmlFor="cat-name-en">الاسم بالإنجليزية</label>
                <input id="cat-name-en" value={nameEn} disabled={createBusy} onChange={(e) => setNameEn(e.target.value)} />
              </div>
            </div>
            <div className="field">
              <label htmlFor="cat-parent">التصنيف الأب (اختياري)</label>
              <select id="cat-parent" value={parentId} disabled={createBusy} onChange={(e) => setParentId(e.target.value)}>
                <option value="">بدون - تصنيف رئيسي</option>
                {rows.map(({ row, depth }) => (
                  <option key={row.id} value={row.id}>
                    {"— ".repeat(depth)}{row.name_ar}
                  </option>
                ))}
              </select>
            </div>
            {createError && <ErrorBanner message={createError} />}
            {duplicates && duplicates.length > 0 && (
              <div className="warning-banner">
                <p style={{ marginTop: 0 }}>توجد تصنيفات مشابهة بالفعل، تأكدي أنّ هذا ليس تكراراً:</p>
                <ul style={{ margin: "0 0 10px", paddingInlineStart: 20 }}>
                  {duplicates.map((d) => (
                    <li key={d.id}>
                      {d.name_ar} / {d.name_en} — تشابه {(d.similarity * 100).toFixed(0)}٪
                    </li>
                  ))}
                </ul>
                <button type="button" className="button" disabled={createBusy} onClick={() => createCategory(true)}>
                  {createBusy ? "جارٍ الإنشاء..." : "إنشاء رغم التشابه"}
                </button>
              </div>
            )}
            <button className="button" type="submit" disabled={createBusy || !nameAr.trim() || !nameEn.trim()}>
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
          <EmptyState title="لا توجد تصنيفات بعد" message="أنشئي أول تصنيف من النموذج أعلاه." />
        )}
        {items && items.length > 0 && (
          <div className="card" style={{ maxWidth: "none" }}>
            {rows.map(({ row, depth }) => (
              <div key={row.id} style={{ borderBottom: "1px solid var(--color-border)", padding: "10px 0" }}>
                {editId === row.id ? (
                  <div style={{ paddingInlineStart: depth * 20 }}>
                    <div className="form-row">
                      <div className="field">
                        <label>الاسم بالعربية</label>
                        <input value={eNameAr} disabled={editBusy} onChange={(e) => setENameAr(e.target.value)} />
                      </div>
                      <div className="field">
                        <label>الاسم بالإنجليزية</label>
                        <input value={eNameEn} disabled={editBusy} onChange={(e) => setENameEn(e.target.value)} />
                      </div>
                    </div>
                    <div className="field">
                      <label>التصنيف الأب</label>
                      <select value={eParentId} disabled={editBusy} onChange={(e) => setEParentId(e.target.value)}>
                        <option value="">بدون - تصنيف رئيسي</option>
                        {rows
                          .filter(({ row: r }) => r.id !== row.id && !descendantIds(row.id).has(r.id))
                          .map(({ row: r, depth: d }) => (
                            <option key={r.id} value={r.id}>
                              {"— ".repeat(d)}{r.name_ar}
                            </option>
                          ))}
                      </select>
                    </div>
                    {editError && <ErrorBanner message={editError} />}
                    <div style={{ display: "flex", gap: 8 }}>
                      <button className="button" disabled={editBusy} onClick={saveEdit}>
                        {editBusy ? "جارٍ الحفظ..." : "حفظ"}
                      </button>
                      <button className="button-link" disabled={editBusy} onClick={() => setEditId(null)}>
                        إلغاء
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
                      {row.is_restricted && <span className="badge">مقيَّد</span>}
                    </div>
                    <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                      <button className="button-link" onClick={() => openEdit(row)}>
                        تعديل
                      </button>
                      {row.is_restricted ? (
                        <button className="button-link" onClick={() => openRestrict(row.id, "unrestrict")}>
                          إلغاء التقييد
                        </button>
                      ) : (
                        <button className="button-link" onClick={() => openRestrict(row.id, "restrict")}>
                          تقييد
                        </button>
                      )}
                      {deleteConfirmId === row.id ? (
                        <>
                          <button className="button-link" disabled={deleteBusy} onClick={() => confirmDelete(row.id)}>
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
                            setDeleteConfirmId(row.id);
                            setDeleteError(null);
                          }}
                        >
                          حذف
                        </button>
                      )}
                    </div>
                  </div>
                )}
                {restrictPanel?.id === row.id && (
                  <div style={{ marginTop: 10, paddingInlineStart: depth * 20 }}>
                    {restrictPanel.mode === "restrict" ? (
                      <div className="field">
                        <label>سبب التقييد</label>
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
                      <p className="muted">هذا سيسمح بإنشاء منتجات مرجعية جديدة تحت هذا التصنيف.</p>
                    )}
                    {restrictError && <ErrorBanner message={restrictError} />}
                    <div style={{ display: "flex", gap: 8 }}>
                      <button
                        className="button"
                        disabled={restrictBusy || (restrictPanel.mode === "restrict" && restrictProblem !== null)}
                        onClick={submitRestrict}
                      >
                        {restrictBusy
                          ? "جارٍ الإرسال..."
                          : restrictPanel.mode === "restrict"
                            ? "تأكيد التقييد"
                            : "تأكيد إلغاء التقييد"}
                      </button>
                      <button className="button-link" disabled={restrictBusy} onClick={() => setRestrictPanel(null)}>
                        إلغاء
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
