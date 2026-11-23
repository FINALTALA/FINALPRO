"use client";

import { useParams, useRouter } from "next/navigation";
import { useEffect } from "react";
import DeliveryBoard from "@/components/branch-delivery/DeliveryBoard";
import { loginRedirectHref } from "@/lib/loginRedirect";
import { useHydrated, useSessionToken } from "@/lib/useSession";

/**
 * «نوافذ التوصيل v1»: the branch's delivery windows - the 7-day board, the
 * weekly template and the preparation time (see DeliveryBoard). Owner: any
 * branch, every action; the branch employee: her own branch, read only (the
 * server refuses every write from her anyway).
 */
export default function BranchDeliveryWindowsPage() {
  const params = useParams<{ vendorId: string; branchId: string }>();
  const router = useRouter();
  const hydrated = useHydrated();
  const token = useSessionToken();

  useEffect(() => {
    if (hydrated && !token) router.replace(loginRedirectHref());
  }, [hydrated, token, router]);

  if (!hydrated || !token) return <div className="skeleton" style={{ height: 320, width: "100%" }} />;
  return <DeliveryBoard vendorId={params.vendorId} branchId={params.branchId} />;
}
