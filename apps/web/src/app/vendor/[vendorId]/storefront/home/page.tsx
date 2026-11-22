"use client";

import { useParams, useRouter } from "next/navigation";
import { useEffect } from "react";
import { StoreHomeDesigner } from "@/components/store-home/StoreHomeDesigner";
import { loginRedirectHref } from "@/lib/loginRedirect";
import { useHydrated, useSessionToken } from "@/lib/useSession";

/**
 * «تصميم الصفحة الرئيسية» (2026-11-20) - opened in the store's management
 * window (its tile, the pencil over the blocks on the store page). Owner
 * only: the API refuses anyone else on every request.
 */
export default function StoreHomeDesignPage() {
  const params = useParams<{ vendorId: string }>();
  const router = useRouter();
  const hydrated = useHydrated();
  const token = useSessionToken();
  useEffect(() => {
    if (hydrated && !token) router.replace(loginRedirectHref());
  }, [hydrated, token, router]);
  if (!hydrated || !token) return <div className="page-shell"><div className="skeleton" style={{ height: 160, maxWidth: 560 }} /></div>;
  return (
    <div className="page-shell">
      <StoreHomeDesigner vendorId={params.vendorId} />
    </div>
  );
}
