"use client";

import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useEffect } from "react";
import { EmptyState } from "@/components/States";
import { useHydrated, useSessionToken, useWorkspaces } from "@/lib/useSession";
import PerformanceSection from "../PerformanceSection";
import { loginRedirectHref } from "@/lib/loginRedirect";

// Sprint 25 (FR-VEND-011, FR-VPORTAL-007): the owner's performance
// indicators, reached from «إدارة المتجر» › «أداء المتجر» since the old
// owner dashboard became the public storefront. OWNER only - the API
// (GET /vendors/:id/performance: VendorMembershipGuard + OWNER role +
// the dashboard feature flag) is the real protection; this page only
// avoids showing an employee an empty shell. Every figure comes from
// that API - nothing is computed or filled in here.
export default function OwnerPerformancePage() {
  const params = useParams<{ vendorId: string }>();
  const router = useRouter();
  const hydrated = useHydrated();
  const token = useSessionToken();
  const workspaces = useWorkspaces(token);
  const membership = workspaces?.find((w) => w.type === "vendor" && w.vendor_id === params.vendorId);
  const isOwner = membership?.type === "vendor" && membership.role === "OWNER";

  useEffect(() => {
    if (hydrated && !token) router.replace(loginRedirectHref());
  }, [hydrated, token, params.vendorId, router]);

  if (!hydrated || !token || workspaces === null) {
    return (
      <div className="page-shell">
        <div className="skeleton" style={{ height: 220, width: "100%", maxWidth: 980 }} />
      </div>
    );
  }
  if (!isOwner) {
    return (
      <div className="page-shell">
        <EmptyState title="هذه الصفحة لصاحب المتجر فقط" actionHref="/account" actionLabel="حسابي" />
      </div>
    );
  }

  return (
    <div className="page-shell owner-performance">
      <div className="top-bar">
        <h1 className="page-title" style={{ margin: 0 }}>أداء المتجر</h1>
        <Link href={`/vendor/${params.vendorId}`} className="button-link">لوحة المتجر</Link>
      </div>
      <p className="muted owner-performance-note">
        محسوبة من طلبات متجرك الفعلية خلال آخر 30 يوماً، ومن تقييمات متجرك الظاهرة. لا تظهر لأي زائر أو موظف.
      </p>
      <PerformanceSection
        vendorId={params.vendorId}
        whenDisabled={
          <div className="card perf-card perf-disabled" role="status">
            <h3 style={{ marginTop: 0 }}>لوحة الأداء غير مفعّلة حالياً</h3>
            <p className="muted" style={{ margin: 0 }}>عندما تفعّلها إدارة المنصة تظهر هنا مؤشرات متجرك تلقائياً.</p>
          </div>
        }
      />
    </div>
  );
}
