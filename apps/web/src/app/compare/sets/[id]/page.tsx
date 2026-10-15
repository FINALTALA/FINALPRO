"use client";

import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import SafeImage from "@/components/SafeImage";
import { EmptyState, ErrorBanner, SkeletonGrid } from "@/components/States";
import { apiFetch, ApiError } from "@/lib/api";
import { clearSession } from "@/lib/session";
import { useFetch } from "@/lib/useFetch";
import { useHydrated, useSessionToken } from "@/lib/useSession";

interface SetItemDto {
  canonical_product_id: string;
  name_ar?: string;
  name_en?: string;
  brand_name?: string | null;
  category_name?: string | null;
  lowest_price?: string;
  image_url?: string | null;
  added_at: string;
  available: boolean;
}

interface SetDetailDto {
  id: string;
  share_slug: string;
  items: SetItemDto[];
}

// Sprint 24 (FR-COMP-001/007): owner view of one saved comparison set
// - add/remove items (max 4, enforced server-side), copy the share
// link. An item that stopped being eligible stays listed, flagged
// unavailable rather than silently vanishing.
export default function ComparisonSetDetailPage() {
  const router = useRouter();
  const params = useParams<{ id: string }>();
  const hydrated = useHydrated();
  const token = useSessionToken();
  const path = token ? `/customers/me/comparison-sets/${params.id}` : null;
  const detail = useFetch<SetDetailDto>(path, true);
  // Sprint 24 review fix: never mirror fetched data into local state
  // via an effect (react-hooks/set-state-in-effect) - `override` is
  // set ONLY by this page's own mutations (add/remove), and `items`
  // below falls back to the fetched detail otherwise.
  const [override, setOverride] = useState<SetItemDto[] | null>(null);
  const [newProductId, setNewProductId] = useState("");
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (detail.status === 401) {
      clearSession();
      router.replace(`/login?next=/compare/sets/${params.id}`);
    }
  }, [detail.status, router, params.id]);

  useEffect(() => {
    if (hydrated && !token) router.replace(`/login?next=/compare/sets/${params.id}`);
  }, [hydrated, token, router, params.id]);

  const items = override ?? detail.data?.items ?? null;

  if (!hydrated || !token) {
    return (
      <div className="page-shell">
        <div className="skeleton" style={{ height: 96, width: "100%", maxWidth: 1240 }} />
      </div>
    );
  }

  async function addItem() {
    const id = newProductId.trim();
    if (!id) return;
    setBusy(true);
    setActionError(null);
    try {
      await apiFetch(`/customers/me/comparison-sets/${params.id}/items`, {
        method: "POST",
        body: { canonical_product_id: id },
      });
      setNewProductId("");
      const fresh = await apiFetch<SetDetailDto>(`/customers/me/comparison-sets/${params.id}`);
      setOverride(fresh.items);
    } catch (err) {
      setActionError(err instanceof ApiError ? err.message : "تعذّر الإضافة");
    } finally {
      setBusy(false);
    }
  }

  async function removeItem(canonicalProductId: string) {
    setOverride(
      (items ?? []).filter((i) => i.canonical_product_id !== canonicalProductId),
    );
    try {
      await apiFetch(
        `/customers/me/comparison-sets/${params.id}/items/${canonicalProductId}`,
        { method: "DELETE" },
      );
    } catch {
      // Non-critical - a failed remove just reappears on next reload.
    }
  }

  async function deleteSet() {
    try {
      await apiFetch(`/customers/me/comparison-sets/${params.id}`, { method: "DELETE" });
    } finally {
      router.push("/compare/sets");
    }
  }

  function copyShareLink() {
    if (!detail.data) return;
    const url = `${window.location.origin}/compare/shared/${detail.data.share_slug}`;
    navigator.clipboard?.writeText(url).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  }

  if (detail.error && detail.status !== 401) {
    return (
      <div className="page-shell">
        <div className="wide-shell">
          {detail.status === 404 ? (
            <EmptyState title="المجموعة غير موجودة" actionHref="/compare/sets" actionLabel="مجموعاتي" />
          ) : (
            <ErrorBanner message={detail.error} />
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="page-shell">
      <div className="wide-shell">
        <div className="top-bar">
          <h1 className="page-title" style={{ margin: 0 }}>مجموعة المقارنة</h1>
          {detail.data && (
            <button className="button-link" onClick={copyShareLink}>
              {copied ? "تم النسخ" : "نسخ رابط المشاركة"}
            </button>
          )}
        </div>

        <div className="card" style={{ marginBottom: 20 }}>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            <input
              type="text"
              placeholder="معرّف منتج جديد"
              value={newProductId}
              onChange={(e) => setNewProductId(e.target.value)}
              style={{ flex: "1 1 240px" }}
            />
            <button className="button" disabled={busy || !newProductId.trim() || (items?.length ?? 0) >= 4} onClick={addItem}>
              إضافة
            </button>
          </div>
          {(items?.length ?? 0) >= 4 && (
            <p className="muted" style={{ marginTop: 6 }}>وصلت المجموعة إلى الحد الأقصى (4 منتجات).</p>
          )}
          {actionError && <ErrorBanner message={actionError} />}
        </div>

        {detail.loading && <SkeletonGrid count={4} />}

        {items && items.length === 0 && (
          <EmptyState title="هذه المجموعة فارغة" message="أضيفي منتجاً أعلاه." />
        )}

        {items && items.length > 0 && (
          <div className="compare-grid">
            {items.map((item) => (
              <div key={item.canonical_product_id} className="compare-card">
                {item.image_url && (
                  <SafeImage src={item.image_url} alt={item.name_ar ?? "منتج"} className="compare-thumb" />
                )}
                {item.available ? (
                  <>
                    <Link href={`/compare/${item.canonical_product_id}`}>
                      <strong>{item.name_ar ?? item.name_en}</strong>
                    </Link>
                    {item.lowest_price && (
                      <div className="product-card-price">{item.lowest_price} ₪</div>
                    )}
                  </>
                ) : (
                  <span className="muted">غير متوفر حالياً</span>
                )}
                <button
                  className="button-link"
                  style={{ marginTop: "auto" }}
                  onClick={() => removeItem(item.canonical_product_id)}
                >
                  إزالة
                </button>
              </div>
            ))}
          </div>
        )}

        <div style={{ marginTop: 20, display: "flex", gap: 14 }}>
          <Link href="/compare/sets" className="button-link">كل مجموعاتي</Link>
          <button className="button-link" onClick={deleteSet}>حذف المجموعة</button>
        </div>
      </div>
    </div>
  );
}
