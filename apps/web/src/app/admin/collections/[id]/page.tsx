"use client";

import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useState } from "react";
import { EmptyState, ErrorBanner } from "@/components/States";
import { apiFetch, ApiError, newIdempotencyKey } from "@/lib/api";
import { isForbidden } from "@/lib/admin";
import {
  AdminCollectionDetail,
  AUDIENCE_LABEL,
  collectionError,
  fromLocalInput,
  liveLabel,
  MAX_COLLECTION_ITEMS,
  NOTE_LABEL,
  STATUS_LABEL,
  toLocalInput,
} from "@/lib/platformCollections";
import { useAdminGate } from "@/lib/useAdminGate";

interface CanonicalProductRow {
  id: string;
  model_name: string;
  canonical_name_ar: string | null;
  canonical_name_en: string | null;
  status: string;
  merged_into_id: string | null;
}

interface FormState {
  slug: string;
  title_ar: string;
  title_en: string;
  description_ar: string;
  description_en: string;
  audience: "" | "WOMEN" | "MEN" | "KIDS";
  show_on_home: boolean;
  publish_from: string;
  publish_until: string;
}

function toForm(c: AdminCollectionDetail): FormState {
  return {
    slug: c.slug,
    title_ar: c.title_ar,
    title_en: c.title_en,
    description_ar: c.description_ar ?? "",
    description_en: c.description_en ?? "",
    audience: c.audience ?? "",
    show_on_home: c.show_on_home,
    publish_from: toLocalInput(c.publish_from),
    publish_until: toLocalInput(c.publish_until),
  };
}

const productName = (p: CanonicalProductRow) => p.canonical_name_ar ?? p.model_name;

// PD-5b.3: one platform collection - its fields, its canonical products
// (search, add, remove, order, ≤24) and its lifecycle. The API decides
// everything (what may be added, transitions, the window); availability
// and the shopper's zone are only checked when the collection is shown.
export default function AdminCollectionPage() {
  const params = useParams<{ id: string }>();
  const gate = useAdminGate("ADMIN");
  const router = useRouter();
  const [c, setC] = useState<AdminCollectionDetail | null>(null);
  const [form, setForm] = useState<FormState | null>(null);
  const [items, setItems] = useState<string[]>([]);
  const [products, setProducts] = useState<CanonicalProductRow[]>([]);
  const [shownNow, setShownNow] = useState<Set<string> | null>(null);
  const [query, setQuery] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [forbidden, setForbidden] = useState(false);
  const [missing, setMissing] = useState(false);
  const [busy, setBusy] = useState(false);

  const adopt = useCallback((d: AdminCollectionDetail) => {
    setC(d);
    setForm(toForm(d));
    setItems(d.items.map((i) => i.canonical_product_id));
    // For a live collection only: what shoppers (no zone chosen) see right now.
    if (d.live) {
      apiFetch<{ products: { canonical_product_id: string }[] }>(`/collections/${d.slug}`, { auth: false })
        .then((r) => setShownNow(new Set(r.products.map((p) => p.canonical_product_id))))
        .catch(() => setShownNow(null));
    } else {
      setShownNow(null);
    }
  }, []);

  const load = useCallback(() => {
    return apiFetch<AdminCollectionDetail>(`/admin/collections/${params.id}`)
      .then((d) => {
        adopt(d);
        setError(null);
      })
      .catch((err) => {
        if (isForbidden(err)) setForbidden(true);
        else if (err instanceof ApiError && err.status === 404) setMissing(true);
        setError(collectionError(err));
      });
  }, [params.id, adopt]);

  useEffect(() => {
    if (gate.status !== "ok") return;
    void load();
    apiFetch<CanonicalProductRow[]>("/canonical-products")
      .then(setProducts)
      .catch(() => setProducts([]));
  }, [gate.status, load]);

  const productById = useMemo(() => new Map(products.map((p) => [p.id, p])), [products]);
  const itemById = useMemo(() => new Map((c?.items ?? []).map((i) => [i.canonical_product_id, i])), [c]);
  const savedItems = (c?.items ?? []).map((i) => i.canonical_product_id);
  const itemsDirty = items.join() !== savedItems.join();
  const archived = c?.status === "ARCHIVED";

  const matches = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (q.length < 2) return [];
    return products
      .filter((p) => !items.includes(p.id))
      .filter((p) => `${p.canonical_name_ar ?? ""} ${p.canonical_name_en ?? ""} ${p.model_name}`.toLowerCase().includes(q))
      .slice(0, 12);
  }, [query, products, items]);

  async function run<T>(work: () => Promise<T>, done: string) {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await work();
      setNotice(done);
    } catch (err) {
      // A merged product: name the product to add instead.
      if (err instanceof ApiError && err.code === "CANONICAL_PRODUCT_MERGED") {
        const detail = err.details[0] as { merged_into_id?: string } | undefined;
        const survivor = detail?.merged_into_id ? productById.get(detail.merged_into_id) : undefined;
        setError(
          survivor
            ? `هذا المنتج مدموج في «${productName(survivor)}» - أضيفي «${productName(survivor)}» بدلاً منه.`
            : collectionError(err),
        );
      } else {
        setError(collectionError(err));
      }
    } finally {
      setBusy(false);
    }
  }

  const saveFields = () =>
    run(async () => {
      if (!form) return;
      const d = await apiFetch<AdminCollectionDetail>(`/admin/collections/${params.id}`, {
        method: "PATCH",
        body: {
          ...(c && !c.ever_published ? { slug: form.slug.trim() } : {}),
          title_ar: form.title_ar.trim(),
          title_en: form.title_en.trim(),
          description_ar: form.description_ar.trim() || null,
          description_en: form.description_en.trim() || null,
          audience: form.audience || null,
          show_on_home: form.show_on_home,
          publish_from: fromLocalInput(form.publish_from),
          publish_until: fromLocalInput(form.publish_until),
        },
        idempotencyKey: newIdempotencyKey("collection-fields"),
      });
      adopt(d);
    }, "تم حفظ البيانات");

  const saveItems = () =>
    run(async () => {
      const d = await apiFetch<AdminCollectionDetail>(`/admin/collections/${params.id}/items`, {
        method: "PUT",
        body: { canonical_product_ids: items },
        idempotencyKey: newIdempotencyKey("collection-items"),
      });
      adopt(d);
    }, "تم حفظ المنتجات");

  const transition = (action: "publish" | "archive" | "reopen", done: string) =>
    run(async () => {
      const d = await apiFetch<AdminCollectionDetail>(`/admin/collections/${params.id}/${action}`, {
        method: "POST",
        idempotencyKey: newIdempotencyKey(`collection-${action}`),
      });
      adopt(d);
    }, done);

  const remove = () => {
    if (!window.confirm("حذف هذه المسودة نهائياً؟")) return;
    void run(async () => {
      await apiFetch(`/admin/collections/${params.id}`, {
        method: "DELETE",
        idempotencyKey: newIdempotencyKey("collection-delete"),
      });
      router.push("/admin/collections");
    }, "تم حذف المسودة");
  };

  function move(index: number, by: -1 | 1) {
    const next = [...items];
    const target = index + by;
    if (target < 0 || target >= next.length) return;
    [next[index], next[target]] = [next[target], next[index]];
    setItems(next);
  }

  // Forbidden first: a non-admin never loads the collection, so "still
  // loading" must not be decided from the missing data alone.
  if (gate.status === "forbidden" || forbidden) {
    return (
      <div className="page-shell">
        <EmptyState title="هذه الصفحة لمدير المنصة فقط" actionHref="/account" actionLabel="حسابي" />
      </div>
    );
  }
  if (gate.status === "loading" || (!c && !error)) {
    return (
      <div className="page-shell">
        <div className="skeleton" style={{ height: 120, width: "100%", maxWidth: 1000 }} />
      </div>
    );
  }
  if (!c || !form) {
    return (
      <div className="page-shell">
        <ErrorBanner message={missing ? "المجموعة غير موجودة" : (error ?? "تعذّر تحميل المجموعة")} />
        {!missing && <button type="button" className="button button-secondary" onClick={() => void load()}>إعادة المحاولة</button>}
        <Link href="/admin/collections" className="button-link">مجموعات المنصة</Link>
      </div>
    );
  }

  const live = liveLabel(c);

  return (
    <div className="page-shell">
      <div className="wide-shell admin-collections" style={{ maxWidth: 1000 }}>
        <div className="top-bar">
          <div>
            <h1 className="page-title" style={{ margin: 0 }}>{c.title_ar}</h1>
            <span className={`badge${c.status === "PUBLISHED" ? " badge-active" : ""}`}>{STATUS_LABEL[c.status]}</span>{" "}
            {live && <span className={`admin-collection-live${c.live ? " is-live" : ""}`}>{live}</span>}
          </div>
          <Link href="/admin/collections" className="button-link">مجموعات المنصة</Link>
        </div>

        {error && <ErrorBanner message={error} />}
        {notice && <p className="muted" role="status">{notice}</p>}

        <section className="card admin-collection-lifecycle">
          <h3 style={{ marginTop: 0 }}>الحالة</h3>
          <div className="admin-collection-actions">
            {c.status === "DRAFT" && (
              <button type="button" className="button" disabled={busy || itemsDirty} onClick={() => transition("publish", "تم النشر")} title={itemsDirty ? "احفظي المنتجات أولاً" : undefined}>
                نشر
              </button>
            )}
            {(c.status === "PUBLISHED" || (c.status === "DRAFT" && c.ever_published)) && (
              <button type="button" className="button button-secondary" disabled={busy} onClick={() => transition("archive", "تمت الأرشفة")}>أرشفة</button>
            )}
            {c.status === "ARCHIVED" && (
              <button type="button" className="button" disabled={busy} onClick={() => transition("reopen", "أعيد فتحها كمسودة")}>إعادة فتح كمسودة</button>
            )}
            {c.status === "DRAFT" && !c.ever_published && (
              <button type="button" className="button-link admin-collection-delete" disabled={busy} onClick={remove}>حذف المسودة</button>
            )}
          </div>
          {archived && <p className="muted">المجموعة مؤرشفة: أعيدي فتحها كمسودة لتعديلها.</p>}
          {c.status === "PUBLISHED" && <p className="muted">لا تُعدَّل الحالة إلى مسودة من النشر مباشرة؛ أرشفيها ثم أعيدي فتحها.</p>}
        </section>

        <section className="card">
          <h3 style={{ marginTop: 0 }}>البيانات</h3>
          <fieldset disabled={busy || archived} className="admin-collection-fields">
            <div className="field">
              <label htmlFor="col-slug">الرابط</label>
              <input id="col-slug" dir="ltr" value={form.slug} disabled={c.ever_published} onChange={(e) => setForm({ ...form, slug: e.target.value })} />
              {c.ever_published && <span className="muted" style={{ fontSize: ".8rem" }}>لا يتغيّر رابط مجموعة سبق نشرها.</span>}
            </div>
            <div className="admin-collection-two">
              <div className="field">
                <label htmlFor="col-title-ar">العنوان بالعربية</label>
                <input id="col-title-ar" maxLength={80} value={form.title_ar} onChange={(e) => setForm({ ...form, title_ar: e.target.value })} />
              </div>
              <div className="field">
                <label htmlFor="col-title-en">العنوان بالإنجليزية</label>
                <input id="col-title-en" dir="ltr" maxLength={80} value={form.title_en} onChange={(e) => setForm({ ...form, title_en: e.target.value })} />
              </div>
              <div className="field">
                <label htmlFor="col-desc-ar">الوصف بالعربية (اختياري)</label>
                <textarea id="col-desc-ar" rows={2} maxLength={280} value={form.description_ar} onChange={(e) => setForm({ ...form, description_ar: e.target.value })} />
              </div>
              <div className="field">
                <label htmlFor="col-desc-en">الوصف بالإنجليزية (اختياري)</label>
                <textarea id="col-desc-en" dir="ltr" rows={2} maxLength={280} value={form.description_en} onChange={(e) => setForm({ ...form, description_en: e.target.value })} />
              </div>
              <div className="field">
                <label htmlFor="col-audience">القسم</label>
                <select id="col-audience" value={form.audience} onChange={(e) => setForm({ ...form, audience: e.target.value as FormState["audience"] })}>
                  <option value="">بلا قسم</option>
                  {Object.entries(AUDIENCE_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
                </select>
              </div>
              <label className="admin-collection-check">
                <input type="checkbox" checked={form.show_on_home} onChange={(e) => setForm({ ...form, show_on_home: e.target.checked })} />
                تظهر في الرئيسية
              </label>
              <div className="field">
                <label htmlFor="col-from">بداية النشر (اختياري)</label>
                <input id="col-from" type="datetime-local" value={form.publish_from} onChange={(e) => setForm({ ...form, publish_from: e.target.value })} />
              </div>
              <div className="field">
                <label htmlFor="col-until">نهاية النشر (اختياري)</label>
                <input id="col-until" type="datetime-local" value={form.publish_until} onChange={(e) => setForm({ ...form, publish_until: e.target.value })} />
              </div>
            </div>
            <button type="button" className="button" onClick={saveFields}>حفظ البيانات</button>
          </fieldset>
        </section>

        <section className="card">
          <div className="top-bar" style={{ marginBottom: 6 }}>
            <h3 style={{ margin: 0 }}>المنتجات ({items.length} / {MAX_COLLECTION_ITEMS})</h3>
            {itemsDirty && <span className="muted">تغييرات غير محفوظة</span>}
          </div>
          <p className="muted admin-collection-note">
            يُفحص توفر كل منتج ومنطقة العميل لحظة عرض المجموعة: يظهر للعميل فقط ما يمكن شراؤه آنذاك، لذا قد لا يظهر كل منتج هنا دائماً.
            لا تظهر المجموعة في الرئيسية أو الأقسام إلا بأربعة منتجات متاحة على الأقل.
          </p>
          {items.length === 0 ? (
            <p className="muted">لا توجد منتجات بعد.</p>
          ) : (
            <ol className="admin-collection-items">
              {items.map((id, index) => {
                const saved = itemById.get(id);
                const p = productById.get(id);
                const name = saved?.name ?? (p ? productName(p) : "منتج");
                const note = saved?.note ?? null;
                const survivor = saved?.merged_into_id ? productById.get(saved.merged_into_id) : undefined;
                const hiddenNow =
                  saved && !note && shownNow !== null && !shownNow.has(id) ? "غير متاح للشراء الآن - لا يظهر للعملاء حالياً" : null;
                return (
                  <li key={id}>
                    <span className="admin-collection-item-name">{name}</span>
                    {note && (
                      <span className={`admin-collection-flag is-${note.toLowerCase()}`}>
                        {NOTE_LABEL[note]}
                        {note === "MERGED" && survivor ? ` («${productName(survivor)}»)` : ""}
                      </span>
                    )}
                    {hiddenNow && <span className="admin-collection-flag is-unavailable">{hiddenNow}</span>}
                    {!saved && <span className="muted">جديد - لم يُحفظ بعد</span>}
                    {!archived && (
                      <span className="admin-collection-actions">
                        <button type="button" className="button-link" aria-label={`تقديم ${name}`} disabled={busy || index === 0} onClick={() => move(index, -1)}>↑</button>
                        <button type="button" className="button-link" aria-label={`تأخير ${name}`} disabled={busy || index === items.length - 1} onClick={() => move(index, 1)}>↓</button>
                        <button type="button" className="button-link" disabled={busy} onClick={() => setItems(items.filter((x) => x !== id))}>إزالة</button>
                      </span>
                    )}
                  </li>
                );
              })}
            </ol>
          )}
          {!archived && (
            <>
              <div className="field" style={{ marginTop: 12 }}>
                <label htmlFor="col-search">إضافة منتج (ابحثي بالاسم)</label>
                <input
                  id="col-search"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder="حرفان على الأقل"
                  disabled={busy || items.length >= MAX_COLLECTION_ITEMS}
                />
                {items.length >= MAX_COLLECTION_ITEMS && <span className="muted">وصلتِ للحد الأقصى ({MAX_COLLECTION_ITEMS}).</span>}
              </div>
              {matches.length > 0 && (
                <ul className="admin-collection-results" aria-label="نتائج البحث">
                  {matches.map((p) => (
                    <li key={p.id}>
                      <span>{productName(p)}</span>
                      {p.status !== "PUBLISHED" && <span className="muted">({p.status === "MERGED" ? "مدموج" : p.status === "ARCHIVED" ? "مؤرشف" : "غير منشور"})</span>}
                      <button
                        type="button"
                        className="button-link"
                        disabled={busy || items.length >= MAX_COLLECTION_ITEMS}
                        onClick={() => {
                          setItems([...items, p.id]);
                          setQuery("");
                        }}
                      >
                        إضافة
                      </button>
                    </li>
                  ))}
                </ul>
              )}
              <button type="button" className="button" disabled={busy || !itemsDirty} onClick={saveItems} style={{ marginTop: 10 }}>
                حفظ المنتجات
              </button>
            </>
          )}
        </section>
      </div>
    </div>
  );
}
