"use client";

import { useParams, useRouter } from "next/navigation";
import { useEffect } from "react";
import { OfferBarcodesManager } from "@/components/pos/OfferBarcodesManager";
import { loginRedirectHref } from "@/lib/loginRedirect";
import { useHydrated, useSessionToken } from "@/lib/useSession";

/**
 * «إدارة الباركود» of one product as its own page (a direct link, or the
 * standalone details page). Inside «المنتجات والعروض» the same screen opens
 * in the management window instead (ManagePanel).
 */
export default function OfferBarcodesPage() {
  const params = useParams<{ vendorId: string; offerId: string }>();
  const router = useRouter();
  const hydrated = useHydrated();
  const token = useSessionToken();
  useEffect(() => {
    if (hydrated && !token) router.replace(loginRedirectHref());
  }, [hydrated, token, router]);
  if (!hydrated || !token) return <div className="page-shell"><div className="skeleton" style={{ height: 160, maxWidth: 560 }} /></div>;
  return (
    <div className="page-shell pos-page-shell">
      <OfferBarcodesManager
        vendorId={params.vendorId}
        offerId={params.offerId}
        onPrint={() => router.push(`/vendor/${params.vendorId}/labels`)}
      />
    </div>
  );
}
