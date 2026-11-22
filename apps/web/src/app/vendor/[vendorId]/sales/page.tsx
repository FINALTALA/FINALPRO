"use client";

import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { EmptyState, ErrorBanner } from "@/components/States";
import { apiFetch, ApiError } from "@/lib/api";
import { formatDateTime } from "@/lib/admin";
import { useTaxonomy } from "@/lib/taxonomy";
import { useHydrated, useSessionToken, useWorkspaces } from "@/lib/useSession";
import { loginRedirectHref } from "@/lib/loginRedirect";

interface OwnerSalesDto {
  computed_at: string | null;
  window_start: string | null;
  entries: {
    offer_id: string;
    title: string | null;
    category_code: string;
    audience: string;
    units: number;
    customers: number;
    bestseller: boolean;
  }[];
}

const AUDIENCE_AR: Record<string, string> = { WOMEN: "نساء", MEN: "رجال", KIDS: "أطفال" };

// PD-5.3: the owner's own sales in the ranking window (the last 30 days)
// - their own offers only, never another store's figures or a rank among
// stores. Only completed, kept sales count; the store's own staff
// buying from it don't. The «الأكثر مبيعاً» mark is shown to customers
// only while the platform has the feature switched on.
export default function OwnerSalesPage() {
  const params = useParams<{ vendorId: string }>();
  const router = useRouter();
  const hydrated = useHydrated();
  const token = useSessionToken();
  const workspaces = useWorkspaces(token);
  const membership = workspaces?.find((w) => w.type === "vendor" && w.vendor_id === params.vendorId);
  const isOwner = membership?.type === "vendor" && membership.role === "OWNER";
  const taxonomy = useTaxonomy();
  const [data, setData] = useState<OwnerSalesDto | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!hydrated) return;
    if (!token) {
      router.replace(loginRedirectHref());
      return;
    }
    if (!isOwner) return;
    let cancelled = false;
    apiFetch<OwnerSalesDto>(`/vendors/${params.vendorId}/sales-rank`)
      .then((res) => !cancelled && setData(res))
      .catch((err) => !cancelled && setError(err instanceof ApiError ? err.message : "تعذّر تحميل المبيعات"));
    return () => {
      cancelled = true;
    };
  }, [hydrated, token, isOwner, params.vendorId, router]);

  if (!hydrated || !workspaces) {
    return <div className="page-shell"><div className="skeleton" style={{ height: 160, width: "100%", maxWidth: 900 }} /></div>;
  }
  if (!isOwner) {
    return (
      <div className="page-shell">
        <EmptyState title="هذه الصفحة لصاحب المتجر فقط" actionHref="/account" actionLabel="حسابي" />
      </div>
    );
  }

  const categoryName = (code: string) => taxonomy.data?.categories.find((c) => c.code === code)?.name_ar ?? code;

  return (
    <div className="page-shell">
      <div className="wide-shell" style={{ maxWidth: 900 }}>
        <div className="top-bar">
          <h1 className="page-title" style={{ margin: 0 }}>مبيعات آخر 30 يوماً</h1>
          <Link href={`/vendor/${params.vendorId}`} className="button-link">لوحة المتجر</Link>
        </div>
        <p className="muted" style={{ lineHeight: 1.7 }}>
          تُحسب من الطلبات المكتملة فقط، دون الملغاة أو المستردة أو المرتجعة، ودون مشتريات صاحب المتجر وموظفيه. تظهر شارة
          «الأكثر مبيعاً» للعملاء عندما تفعّلها إدارة المنصة، ولمنتج حقق 5 وحدات على الأقل من 3 عملاء مختلفين ضمن أعلى 10 في
          قسمه وتصنيفه، بوجود 3 منتجات مؤهلة أخرى على الأقل.
        </p>

        {error && <ErrorBanner message={error} />}
        {!data && !error && <div className="skeleton" style={{ height: 160, width: "100%" }} />}
        {data && (data.entries.length === 0 ? (
          <EmptyState title="لا توجد مبيعات محتسبة لعروضكم خلال آخر 30 يوماً" />
        ) : (
          <div style={{ overflowX: "auto" }}>
            <table className="data-table">
              <thead>
                <tr>
                  <th>المنتج</th>
                  <th>القسم والتصنيف</th>
                  <th>الوحدات</th>
                  <th>العملاء</th>
                  <th>الشارة</th>
                </tr>
              </thead>
              <tbody>
                {data.entries.map((e) => (
                  <tr key={`${e.offer_id}|${e.category_code}|${e.audience}`}>
                    <td>
                      <Link href={`/vendor/${params.vendorId}/offers/${e.offer_id}`}>{e.title ?? "—"}</Link>
                    </td>
                    <td>{categoryName(e.category_code)} - {AUDIENCE_AR[e.audience] ?? e.audience}</td>
                    <td>{e.units}</td>
                    <td>{e.customers}</td>
                    <td>{e.bestseller ? <span className="badge badge-active">مؤهل</span> : <span className="muted">غير مؤهل</span>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ))}
        {data?.computed_at && (
          <p className="muted" style={{ fontSize: 13 }}>آخر تحديث: {formatDateTime(data.computed_at)} (يُعاد الحساب كل ساعة)</p>
        )}
      </div>
    </div>
  );
}
