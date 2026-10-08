"use client";

import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { ErrorBanner } from "@/components/States";
import { ApiError, apiFetch, newIdempotencyKey } from "@/lib/api";
import { useHydrated, useSessionToken, useWorkspaces } from "@/lib/useSession";

// Sprint 20b (FR-PRICE-006, FR-CART-003): the branch's own default
// minimum order value - the floor for every PICKUP order at this
// branch, and the fallback for a DELIVERY order whose zone has no
// override of its own (see /vendor/:id/delivery-zones's own minimum-
// order field for that half). Checked against the items-only
// subtotal of a branch-group at checkout, never delivery fee or any
// future tax/fee.
export default function BranchMinimumOrderPage() {
  const params = useParams<{ vendorId: string; branchId: string }>();
  const router = useRouter();
  const hydrated = useHydrated();
  const token = useSessionToken();
  const workspaces = useWorkspaces(token);
  const membership = workspaces?.find(
    (w) => w.type === "vendor" && w.vendor_id === params.vendorId,
  );
  const isOwner = membership?.type === "vendor" && membership.role === "OWNER";

  const [value, setValue] = useState<number | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  function load() {
    apiFetch<{ minimum_order_value: number | null }>(
      `/vendors/${params.vendorId}/branches/${params.branchId}/minimum-order`,
    )
      .then((res) => {
        setValue(res.minimum_order_value);
        setLoaded(true);
      })
      .catch((err) => {
        setError(err instanceof ApiError ? err.message : "تعذّر تحميل الحد الأدنى");
      });
  }

  useEffect(() => {
    if (!hydrated) return;
    if (!token) {
      router.replace(
        `/login?next=/vendor/${params.vendorId}/branches/${params.branchId}/minimum-order`,
      );
      return;
    }
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hydrated, token, params.vendorId, params.branchId]);

  async function save() {
    setSaving(true);
    setError(null);
    setNotice(null);
    try {
      await apiFetch(
        `/vendors/${params.vendorId}/branches/${params.branchId}/minimum-order`,
        {
          method: "PUT",
          body: { minimum_order_value: value },
          idempotencyKey: newIdempotencyKey("branch-minimum-order"),
        },
      );
      setNotice("تم الحفظ");
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "تعذّر حفظ الحد الأدنى");
    } finally {
      setSaving(false);
    }
  }

  if (!hydrated || !token) {
    return (
      <div className="page-shell">
        <div className="skeleton" style={{ height: 120, width: "100%", maxWidth: 560 }} />
      </div>
    );
  }

  return (
    <div className="page-shell">
      <div className="top-bar">
        <h1 className="page-title" style={{ margin: 0 }}>الحد الأدنى للطلب</h1>
        <Link href={`/vendor/${params.vendorId}/branches`} className="button-link">الفروع</Link>
      </div>
      {error && <ErrorBanner message={error} />}
      {notice && <p className="muted">{notice}</p>}

      {!loaded && !error && (
        <div className="skeleton" style={{ height: 80, width: "100%", maxWidth: 560 }} />
      )}
      {loaded && (
        <div className="card" style={{ maxWidth: 560 }}>
          <p className="muted" style={{ marginTop: 0 }}>
            الحد الافتراضي لهذا الفرع - يُطبَّق على طلبات الاستلام من المحل دائماً، وعلى
            طلبات التوصيل فقط إن لم تحدِّدي حداً خاصاً للمنطقة في صفحة مناطق التوصيل. يُحسب
            على سعر الأصناف فقط، بدون رسوم التوصيل.
          </p>
          <div className="field">
            <label>الحد الأدنى (₪)</label>
            <input
              type="number"
              min={0}
              disabled={!isOwner}
              value={value ?? ""}
              placeholder="بلا حد أدنى"
              onChange={(e) => setValue(e.target.value === "" ? null : Number(e.target.value))}
            />
          </div>
          {isOwner && (
            <button className="button" disabled={saving} onClick={save}>
              حفظ
            </button>
          )}
        </div>
      )}
    </div>
  );
}
