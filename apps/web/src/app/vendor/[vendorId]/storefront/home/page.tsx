"use client";

import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useEffect } from "react";
import { StoreHomeDesigner } from "@/components/store-home/StoreHomeDesigner";
import { loginRedirectHref } from "@/lib/loginRedirect";
import "@/lib/storeHomeText";
import { useT } from "@/lib/useLang";
import { useHydrated, useSessionToken } from "@/lib/useSession";

/**
 * «تصميم الصفحة الرئيسية» (2026-11-20) - since 2026-11-23 the «الرئيسية»
 * action of «صفحتي»: in the store's management window it is pushed on top of
 * «صفحتي» (the window's «رجوع» goes back there; an old link or the pencil over
 * the blocks is routed through «صفحتي» first). Opened as a page of its own, a
 * quiet link leads back to «صفحتي». Owner only: the API refuses anyone else
 * on every request.
 */
export default function StoreHomeDesignPage() {
  const params = useParams<{ vendorId: string }>();
  const router = useRouter();
  const hydrated = useHydrated();
  const token = useSessionToken();
  const t = useT();
  useEffect(() => {
    if (hydrated && !token) router.replace(loginRedirectHref());
  }, [hydrated, token, router]);
  if (!hydrated || !token) return <div className="page-shell"><div className="skeleton" style={{ height: 160, maxWidth: 560 }} /></div>;
  return (
    <div className="page-shell">
      <Link href={`/vendor/${params.vendorId}/storefront`} className="mypage-back" data-testid="mypage-back">
        <span aria-hidden="true" className="icon-flip-rtl">‹</span> {t("mypage.back")}
      </Link>
      <StoreHomeDesigner vendorId={params.vendorId} />
    </div>
  );
}
