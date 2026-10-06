"use client";

import Link from "next/link";
import { FormEvent, useCallback, useEffect, useState } from "react";
import { EmptyState, ErrorBanner } from "@/components/States";
import { ApiError, apiFetch, newIdempotencyKey } from "@/lib/api";
import {
  CANONICAL_PRODUCT_STATUS_LABEL,
  adminErrorMessage,
  isForbidden,
} from "@/lib/admin";
import { useAdminGate } from "@/lib/useAdminGate";

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
  const [items, setItems] = useState<CanonicalProductRow[] | null>(null);
  const [brands, setBrands] = useState<BrandRow[]>([]);
  const [categories, setCategories] = useState<CategoryRow[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [forbidden, setForbidden] = useState(false);

  const load = useCallback(() => {
    apiFetch<CanonicalProductRow[]>("/canonical-products")
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
    if (gate.status !== "ok") return;
    load();
    apiFetch<BrandRow[]>("/brands").then(setBrands).catch(() => {});
    apiFetch<CategoryRow[]>("/categories").then(setCategories).catch(() => {});
  }, [gate.status, load]);

  const brandName = (id: string) => brands.find((b) => b.id === id)?.name ?? "—";
  const categoryName = (id: string) => categories.find((c) => c.id === id)?.name_ar ?? "—";

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
        setCreateError(adminErrorMessage(err));
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
        <EmptyState title="هذه الصفحة لمدير المنصة فقط" actionHref="/account" actionLabel="حسابي" />
      </div>
    );
  }

  return (
    <div className="page-shell">
      <div className="wide-shell" style={{ maxWidth: 1000 }}>
        <div className="top-bar">
          <h1 className="page-title" style={{ margin: 0 }}>المنتجات المرجعية</h1>
          <Link href="/admin" className="button-link">إدارة المنصة</Link>
        </div>

        {error && <ErrorBanner message={error} />}

        <div className="card" style={{ maxWidth: "none", marginBottom: 16 }}>
          <h3 style={{ marginTop: 0 }}>منتج مرجعي جديد (يبدأ كمسودة)</h3>
          <form onSubmit={submitCreate}>
            <div className="form-row">
              <div className="field">
                <label htmlFor="cp-brand">العلامة التجارية</label>
                <select id="cp-brand" value={brandId} disabled={createBusy} onChange={(e) => setBrandId(e.target.value)}>
                  <option value="">اختاري علامة تجارية</option>
                  {brands.map((b) => (
                    <option key={b.id} value={b.id}>{b.name}</option>
                  ))}
                </select>
              </div>
              <div className="field">
                <label htmlFor="cp-category">التصنيف</label>
                <select id="cp-category" value={categoryId} disabled={createBusy} onChange={(e) => setCategoryId(e.target.value)}>
                  <option value="">اختاري تصنيفاً</option>
                  {categories.map((c) => (
                    <option key={c.id} value={c.id}>{c.name_ar}</option>
                  ))}
                </select>
              </div>
            </div>
            <div className="field">
              <label htmlFor="cp-model">اسم الطراز (Model name)</label>
              <input id="cp-model" value={modelName} disabled={createBusy} onChange={(e) => setModelName(e.target.value)} />
            </div>
            {createError && <ErrorBanner message={createError} />}
            {duplicates && duplicates.length > 0 && (
              <div className="warning-banner">
                <p style={{ marginTop: 0 }}>توجد منتجات مرجعية مشابهة بالفعل، تأكدي أنّ هذا ليس تكراراً:</p>
                <ul style={{ margin: "0 0 10px", paddingInlineStart: 20 }}>
                  {duplicates.map((d) => (
                    <li key={d.id}>
                      {d.model_name} — تشابه {(d.similarity * 100).toFixed(0)}٪
                    </li>
                  ))}
                </ul>
                <button type="button" className="button" disabled={createBusy} onClick={() => createProduct(true)}>
                  {createBusy ? "جارٍ الإنشاء..." : "إنشاء رغم التشابه"}
                </button>
              </div>
            )}
            <button className="button" type="submit" disabled={createBusy || !brandId || !categoryId || !modelName.trim()}>
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
          <EmptyState title="لا توجد منتجات مرجعية بعد" message="أنشئي أول منتج مرجعي من النموذج أعلاه." />
        )}
        {items && items.length > 0 && (
          <div style={{ overflowX: "auto" }}>
            <table className="data-table">
              <thead>
                <tr>
                  <th>الطراز</th>
                  <th>العلامة التجارية</th>
                  <th>التصنيف</th>
                  <th>الحالة</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {items.map((p) => (
                  <tr key={p.id}>
                    <td>
                      {p.canonical_name_ar ?? p.model_name}
                      {p.is_restricted && <span className="badge" style={{ marginInlineStart: 8 }}>مقيَّد</span>}
                    </td>
                    <td>{brandName(p.brand_id)}</td>
                    <td>{categoryName(p.category_id)}</td>
                    <td>
                      <span className={`badge${p.status === "PUBLISHED" ? " badge-active" : ""}`}>
                        {CANONICAL_PRODUCT_STATUS_LABEL[p.status] ?? p.status}
                      </span>
                    </td>
                    <td>
                      <Link className="button-link" href={`/admin/canonical-products/${p.id}`}>التفاصيل</Link>
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
