"use client";

import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useEffect } from "react";
import { EmptyState } from "@/components/States";
import { ownerHubTiles, workspaceEntry } from "@/lib/nav";
import { useFetch } from "@/lib/useFetch";
import { useHydrated, useSessionToken, useWorkspaces } from "@/lib/useSession";

interface OwnerStorefrontDto {
  slug: string;
  display_name: string;
  is_published: boolean;
}

interface VendorPerformanceDto {
  cancellation_rate: number | null;
  average_response_time_hours: number | null;
  responded_orders_count: number;
  rating_average: number | null;
  rating_count: number;
}

function formatPercent(v: number | null): string {
  if (v === null) return "-";
  return `${(v * 100).toFixed(1)}%`;
}

function formatHours(v: number | null): string {
  if (v === null) return "-";
  return `${v.toFixed(1)} ساعة`;
}

// Sprint 13: the owner dashboard - direct links to everything an owner
// manages. Owner-only in the UI: a branch employee who lands here (by
// URL or a stale bookmark) is sent to their own branch's orders, and a
// non-member sees a plain message. Hiding is UX only - every linked
// page and API call is still authorized by the backend
// (VendorMembershipGuard + @RequireVendorRole).
export default function OwnerHubPage() {
  const params = useParams<{ vendorId: string }>();
  const router = useRouter();
  const hydrated = useHydrated();
  const token = useSessionToken();
  const workspaces = useWorkspaces(token);
  const membership = workspaces?.find(
    (w) => w.type === "vendor" && w.vendor_id === params.vendorId,
  );
  const isOwner = membership?.type === "vendor" && membership.role === "OWNER";
  const storefront = useFetch<OwnerStorefrontDto>(
    isOwner ? `/vendors/${params.vendorId}/storefront` : null,
    true,
  );
  // Sprint 25 (FR-VEND-011, FR-VPORTAL-007): the section is omitted
  // entirely (not an error banner) when the dashboard flag is off -
  // the API returns a plain 404 FEATURE_DISABLED for that case, which
  // isn't a failure worth alarming the owner about.
  const performance = useFetch<VendorPerformanceDto>(
    isOwner ? `/vendors/${params.vendorId}/performance` : null,
    true,
  );

  useEffect(() => {
    if (!hydrated) return;
    if (!token) {
      router.replace(`/login?next=/vendor/${params.vendorId}`);
      return;
    }
    if (membership?.type === "vendor" && membership.role === "BRANCH_EMPLOYEE") {
      router.replace(workspaceEntry(membership).href);
    }
  }, [hydrated, token, membership, params.vendorId, router]);

  if (!hydrated || !token || workspaces === null) {
    return (
      <div className="page-shell">
        <div className="skeleton" style={{ height: 120, width: "100%", maxWidth: 1000 }} />
      </div>
    );
  }

  if (!membership) {
    return (
      <div className="page-shell">
        <EmptyState title="لا تملكين صلاحية على هذا المتجر" actionHref="/account" actionLabel="حسابي" />
      </div>
    );
  }
  if (!isOwner) {
    return (
      <div className="page-shell">
        <p className="muted">جارٍ التحويل إلى طلبات فرعك...</p>
      </div>
    );
  }

  return (
    <div className="page-shell">
      <div className="wide-shell" style={{ maxWidth: 1000 }}>
        <div className="top-bar">
          <div>
            <h1 className="page-title" style={{ margin: 0 }}>
              لوحة المتجر - {membership.vendor_legal_name}
            </h1>
            {storefront.data && (
              <span className={`badge${storefront.data.is_published ? " badge-active" : ""}`}>
                {storefront.data.is_published ? "المتجر منشور" : "المتجر غير منشور"}
              </span>
            )}
          </div>
          {storefront.data && (
            <Link href={`/store/${storefront.data.slug}`} className="button-link">
              عرض صفحة المتجر العامة
            </Link>
          )}
        </div>
        <div className="hub-grid">
          {ownerHubTiles(params.vendorId).map((t) => (
            <Link key={t.href} href={t.href} className="hub-tile">
              <strong>{t.title}</strong>
              <span>{t.description}</span>
            </Link>
          ))}
        </div>

        {performance.data && (
          <div className="card" style={{ maxWidth: "none", marginTop: 16 }}>
            <h3 style={{ marginTop: 0 }}>مؤشرات الأداء (آخر 30 يوماً)</h3>
            <div style={{ display: "flex", gap: 24, flexWrap: "wrap" }}>
              <div>
                <div className="muted">معدّل الإلغاء</div>
                <div style={{ fontWeight: 600 }}>{formatPercent(performance.data.cancellation_rate)}</div>
              </div>
              <div>
                <div className="muted">متوسط زمن الاستجابة</div>
                <div style={{ fontWeight: 600 }}>{formatHours(performance.data.average_response_time_hours)}</div>
              </div>
              <div>
                <div className="muted">عدد الطلبات المستجاب لها</div>
                <div style={{ fontWeight: 600 }}>{performance.data.responded_orders_count}</div>
              </div>
              <div>
                <div className="muted">التقييم</div>
                <div style={{ fontWeight: 600 }}>
                  {performance.data.rating_average === null
                    ? "-"
                    : `${performance.data.rating_average.toFixed(1)} (${performance.data.rating_count})`}
                </div>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
