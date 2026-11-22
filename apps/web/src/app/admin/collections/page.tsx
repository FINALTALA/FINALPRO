"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { EmptyState, ErrorBanner } from "@/components/States";
import { apiFetch, newIdempotencyKey } from "@/lib/api";
import { isForbidden } from "@/lib/admin";
import {
  AdminCollection,
  AUDIENCE_LABEL,
  collectionError,
  formatWindow,
  liveLabel,
  STATUS_LABEL,
} from "@/lib/platformCollections";
import { useAdminGate } from "@/lib/useAdminGate";

// PD-5b.3: the PLATFORM_ADMIN's platform collections - list, create a
// draft, lifecycle actions and display order. Every rule (transitions,
// delete policy, order) is the API's; this page only shows what it
// returns and words its refusals.
export default function AdminCollectionsPage() {
  const gate = useAdminGate("ADMIN");
  const router = useRouter();
  const [list, setList] = useState<AdminCollection[] | null>(null);
  const [order, setOrder] = useState<string[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [forbidden, setForbidden] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [form, setForm] = useState({ slug: "", title_ar: "", title_en: "" });

  const load = useCallback(() => {
    return apiFetch<AdminCollection[]>("/admin/collections")
      .then((rows) => {
        setList(rows);
        setOrder(rows.map((r) => r.id));
        setError(null);
      })
      .catch((err) => {
        if (isForbidden(err)) setForbidden(true);
        setError(collectionError(err));
      });
  }, []);

  useEffect(() => {
    if (gate.status !== "ok") return;
    void load();
  }, [gate.status, load]);

  async function act(id: string, action: "publish" | "archive" | "reopen" | "delete", done: string) {
    if (action === "delete" && !window.confirm("حذف هذه المسودة نهائياً؟")) return;
    setBusy(id);
    setError(null);
    setNotice(null);
    try {
      await apiFetch(action === "delete" ? `/admin/collections/${id}` : `/admin/collections/${id}/${action}`, {
        method: action === "delete" ? "DELETE" : "POST",
        idempotencyKey: newIdempotencyKey(`collection-${action}`),
      });
      setNotice(done);
      await load();
    } catch (err) {
      setError(collectionError(err));
    } finally {
      setBusy(null);
    }
  }

  async function create(e: React.FormEvent) {
    e.preventDefault();
    setBusy("create");
    setError(null);
    try {
      const c = await apiFetch<{ id: string }>("/admin/collections", {
        method: "POST",
        body: { slug: form.slug.trim(), title_ar: form.title_ar.trim(), title_en: form.title_en.trim() },
        idempotencyKey: newIdempotencyKey("collection-create"),
      });
      router.push(`/admin/collections/${c.id}`);
    } catch (err) {
      setError(collectionError(err));
      setBusy(null);
    }
  }

  function move(index: number, by: -1 | 1) {
    if (!order) return;
    const next = [...order];
    const target = index + by;
    if (target < 0 || target >= next.length) return;
    [next[index], next[target]] = [next[target], next[index]];
    setOrder(next);
  }

  async function saveOrder() {
    if (!order) return;
    setBusy("order");
    setError(null);
    setNotice(null);
    try {
      const rows = await apiFetch<AdminCollection[]>("/admin/collections/order", {
        method: "PUT",
        body: { collection_ids: order },
        idempotencyKey: newIdempotencyKey("collection-order"),
      });
      setList(rows);
      setOrder(rows.map((r) => r.id));
      setNotice("تم حفظ ترتيب المجموعات");
    } catch (err) {
      setError(collectionError(err));
    } finally {
      setBusy(null);
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

  const byId = new Map((list ?? []).map((c) => [c.id, c]));
  const ordered = (order ?? []).map((id) => byId.get(id)).filter((c): c is AdminCollection => !!c);
  const orderChanged = !!list && !!order && order.join() !== list.map((c) => c.id).join();

  return (
    <div className="page-shell">
      <div className="wide-shell admin-collections" style={{ maxWidth: 1000 }}>
        <div className="top-bar">
          <h1 className="page-title" style={{ margin: 0 }}>مجموعات المنصة</h1>
          <Link href="/admin" className="button-link">إدارة المنصة</Link>
        </div>
        <p className="muted">
          مجموعات تحريرية من المنتجات الموحّدة. تظهر للعملاء المجموعة المنشورة ضمن نافذة نشرها فقط، ويظهر منها فقط ما يمكن شراؤه
          لحظة العرض وفق منطقة العميل.
        </p>

        {error && <ErrorBanner message={error} />}
        {notice && <p className="muted" role="status">{notice}</p>}

        <section className="card" style={{ maxWidth: 560, marginBottom: 16 }}>
          <h3 style={{ marginTop: 0 }}>مسودة جديدة</h3>
          <form onSubmit={create}>
            <div className="field">
              <label htmlFor="col-slug">الرابط (حروف إنجليزية صغيرة وأرقام وشرطات)</label>
              <input id="col-slug" dir="ltr" required pattern="[a-z0-9][a-z0-9\-]{1,59}" value={form.slug} onChange={(e) => setForm({ ...form, slug: e.target.value })} placeholder="new-in" />
            </div>
            <div className="field">
              <label htmlFor="col-title-ar">العنوان بالعربية</label>
              <input id="col-title-ar" required maxLength={80} value={form.title_ar} onChange={(e) => setForm({ ...form, title_ar: e.target.value })} />
            </div>
            <div className="field">
              <label htmlFor="col-title-en">العنوان بالإنجليزية</label>
              <input id="col-title-en" dir="ltr" required maxLength={80} value={form.title_en} onChange={(e) => setForm({ ...form, title_en: e.target.value })} />
            </div>
            <button type="submit" className="button" disabled={busy !== null}>إنشاء مسودة</button>
          </form>
        </section>

        <section className="card">
          <div className="top-bar" style={{ marginBottom: 8 }}>
            <h3 style={{ margin: 0 }}>المجموعات</h3>
            {orderChanged && (
              <button type="button" className="button" onClick={saveOrder} disabled={busy !== null}>حفظ الترتيب</button>
            )}
          </div>
          {!list ? (
            error ? (
              <button type="button" className="button button-secondary" onClick={() => void load()}>إعادة المحاولة</button>
            ) : (
              <div className="skeleton" style={{ height: 60, width: "100%" }} aria-busy="true" />
            )
          ) : ordered.length === 0 ? (
            <p className="muted">لا توجد مجموعات بعد.</p>
          ) : (
            <ol className="admin-collection-list">
              {ordered.map((c, index) => {
                const live = liveLabel(c);
                return (
                  <li key={c.id} className="admin-collection-row">
                    <div className="admin-collection-main">
                      <div className="admin-collection-titles">
                        <strong>{c.title_ar}</strong>
                        <span className="muted" dir="ltr">{c.title_en}</span>
                      </div>
                      <div className="admin-collection-meta">
                        <span className={`badge${c.status === "PUBLISHED" ? " badge-active" : ""}`}>{STATUS_LABEL[c.status]}</span>
                        {live && <span className={`admin-collection-live${c.live ? " is-live" : ""}`}>{live}</span>}
                        <span>{c.audience ? AUDIENCE_LABEL[c.audience] : "بلا قسم"}</span>
                        <span>{c.show_on_home ? "في الرئيسية" : "ليست في الرئيسية"}</span>
                        <span>{c.item_count ?? 0} / 24 منتجاً</span>
                        <span>{formatWindow(c)}</span>
                      </div>
                    </div>
                    <div className="admin-collection-actions">
                      <button type="button" className="button-link" aria-label={`تقديم ${c.title_ar}`} onClick={() => move(index, -1)} disabled={busy !== null || index === 0}>↑</button>
                      <button type="button" className="button-link" aria-label={`تأخير ${c.title_ar}`} onClick={() => move(index, 1)} disabled={busy !== null || index === ordered.length - 1}>↓</button>
                      <Link href={`/admin/collections/${c.id}`} className="button-link">فتح/تعديل</Link>
                      {c.status === "DRAFT" && (
                        <button type="button" className="button-link" disabled={busy !== null} onClick={() => act(c.id, "publish", "تم النشر")}>نشر</button>
                      )}
                      {(c.status === "PUBLISHED" || (c.status === "DRAFT" && c.ever_published)) && (
                        <button type="button" className="button-link" disabled={busy !== null} onClick={() => act(c.id, "archive", "تمت الأرشفة")}>أرشفة</button>
                      )}
                      {c.status === "ARCHIVED" && (
                        <button type="button" className="button-link" disabled={busy !== null} onClick={() => act(c.id, "reopen", "أعيد فتحها كمسودة")}>إعادة فتح كمسودة</button>
                      )}
                      {c.status === "DRAFT" && !c.ever_published && (
                        <button type="button" className="button-link admin-collection-delete" disabled={busy !== null} onClick={() => act(c.id, "delete", "تم حذف المسودة")}>حذف</button>
                      )}
                    </div>
                  </li>
                );
              })}
            </ol>
          )}
        </section>
      </div>
    </div>
  );
}
