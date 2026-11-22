"use client";

import { useParams, useRouter } from "next/navigation";
import { useEffect } from "react";

/**
 * The old «الأقسام / تصنيفات المتجر» page. Its collections are now
 * «مجموعات المتجر», managed from «المنتجات والعروض» (its toolbar opens
 * them in the management window) - an old link lands there.
 */
export default function StoreSectionsRedirect() {
  const params = useParams<{ vendorId: string }>();
  const router = useRouter();
  useEffect(() => {
    router.replace(`/vendor/${params.vendorId}/offers?open=collections`);
  }, [params.vendorId, router]);
  return (
    <div className="page-shell" aria-busy="true">
      <div className="skeleton" style={{ height: 96, width: "100%", maxWidth: 720 }} />
    </div>
  );
}
