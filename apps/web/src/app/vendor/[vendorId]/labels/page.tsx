"use client";

import { useParams, useRouter } from "next/navigation";
import { useEffect } from "react";
import { LabelsScreen } from "@/components/pos/LabelsScreen";
import { loginRedirectHref } from "@/lib/loginRedirect";
import { useHydrated, useSessionToken } from "@/lib/useSession";

/**
 * «طباعة ملصقات» as its own page - the store's management window opens it
 * (its tile, «إدارة الباركود», the wizard). Its list is this device's print
 * list for the store (lib/printList.ts).
 */
export default function BarcodeLabelsPage() {
  const params = useParams<{ vendorId: string }>();
  const router = useRouter();
  const hydrated = useHydrated();
  const token = useSessionToken();
  useEffect(() => {
    if (hydrated && !token) router.replace(loginRedirectHref());
  }, [hydrated, token, router]);
  if (!hydrated || !token) return <div className="page-shell"><div className="skeleton" style={{ height: 160, maxWidth: 560 }} /></div>;
  return (
    <div className="page-shell pos-page-shell">
      <LabelsScreen vendorId={params.vendorId} />
    </div>
  );
}
