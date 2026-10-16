"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { EmptyState, ErrorBanner, SkeletonGrid } from "@/components/States";
import { apiFetch, ApiError } from "@/lib/api";
import { clearSession } from "@/lib/session";
import { useFetch } from "@/lib/useFetch";
import { useHydrated, useSessionToken } from "@/lib/useSession";

const LOGIN_REDIRECT = "/login?next=/compare/sets";

interface ComparisonSetSummaryDto {
  id: string;
  share_slug: string;
  item_count: number;
  created_at: string;
}

// Sprint 24 (FR-COMP-001/002/007): the customer's own saved comparison
// sets - up to 4 products each, a share link each. Creating one here
// needs at least one canonical_product_id, which this page collects
// as a plain comma-free id list (no product picker UI this sprint -
// the usual way in is "أضيفي للمقارنة" from a product's own page,
// once that button exists; this list/create screen is the hub either
// way).
export default function ComparisonSetsPage() {
  const router = useRouter();
  const hydrated = useHydrated();
  const token = useSessionToken();
  const sets = useFetch<ComparisonSetSummaryDto[]>(token ? "/customers/me/comparison-sets" : null, true);
  const [newProductId, setNewProductId] = useState("");
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);

  useEffect(() => {
    if (sets.status === 401) {
      clearSession();
      router.replace(LOGIN_REDIRECT);
    }
  }, [sets.status, router]);

  useEffect(() => {
    if (hydrated && !token) router.replace(LOGIN_REDIRECT);
  }, [hydrated, token, router]);

  if (!hydrated || !token) {
    return (
      <div className="page-shell">
        <div className="skeleton" style={{ height: 96, width: "100%", maxWidth: 720 }} />
      </div>
    );
  }

  async function createSet() {
    const id = newProductId.trim();
    if (!id) return;
    setCreating(true);
    setCreateError(null);
    try {
      const created = await apiFetch<{ id: string; share_slug: string }>(
        "/customers/me/comparison-sets",
        { method: "POST", body: { canonical_product_ids: [id] } },
      );
      router.push(`/compare/sets/${created.id}`);
    } catch (err) {
      setCreateError(err instanceof ApiError ? err.message : "تعذّر إنشاء المجموعة");
    } finally {
      setCreating(false);
    }
  }

  const items = sets.data ?? [];

  return (
    <div className="page-shell">
      <div style={{ maxWidth: 720, width: "100%" }}>
        <h1 className="page-title">مجموعات المقارنة المحفوظة</h1>
        <p className="page-subtitle">احفظي حتى 4 منتجات في كل مجموعة وشاركيها برابط.</p>

        {sets.error && sets.status !== 401 && <ErrorBanner message={sets.error} />}

        <div className="card" style={{ marginBottom: 20 }}>
          <strong style={{ display: "block", marginBottom: 8 }}>مجموعة جديدة</strong>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            <input
              type="text"
              placeholder="معرّف المنتج الأساسي (canonical_product_id)"
              value={newProductId}
              onChange={(e) => setNewProductId(e.target.value)}
              style={{ flex: "1 1 240px" }}
            />
            <button className="button" disabled={creating || !newProductId.trim()} onClick={createSet}>
              {creating ? "جارٍ الإنشاء..." : "إنشاء"}
            </button>
          </div>
          {createError && <ErrorBanner message={createError} />}
        </div>

        {sets.loading && <SkeletonGrid count={2} />}

        {!sets.loading && items.length === 0 && (
          <EmptyState title="لا توجد مجموعات محفوظة بعد" message="أنشئي مجموعتك الأولى أعلاه." />
        )}

        {items.length > 0 && (
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {items.map((s) => (
              <Link key={s.id} href={`/compare/sets/${s.id}`} className="card" style={{ textDecoration: "none", color: "inherit" }}>
                <strong>مجموعة من {s.item_count} {s.item_count === 1 ? "منتج" : "منتجات"}</strong>
                <div className="muted" style={{ fontSize: 13 }}>
                  {new Date(s.created_at).toLocaleDateString("ar")}
                </div>
              </Link>
            ))}
          </div>
        )}

        <div style={{ marginTop: 20, display: "flex", gap: 14 }}>
          <Link href="/account/favorites" className="button-link">المفضلة</Link>
          <Link href="/compare/cross" className="button-link">مقارنة منتجات منافسة</Link>
        </div>
      </div>
    </div>
  );
}
