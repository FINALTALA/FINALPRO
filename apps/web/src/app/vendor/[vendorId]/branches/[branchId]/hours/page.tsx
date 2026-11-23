"use client";

import { useParams, useRouter } from "next/navigation";
import { useEffect } from "react";
import HoursBoard from "@/components/branch-hours/HoursBoard";
import { loginRedirectHref } from "@/lib/loginRedirect";
import { useHydrated, useSessionToken } from "@/lib/useSession";

/**
 * «ساعات العمل والإغلاقات v1»: the branch's weekly opening hours and its
 * temporary closures (see HoursBoard). Owner: every branch, edits; the
 * branch employee: their own branch, read only (the server refuses every
 * write from them anyway).
 */
export default function BranchHoursPage() {
  const params = useParams<{ vendorId: string; branchId: string }>();
  const router = useRouter();
  const hydrated = useHydrated();
  const token = useSessionToken();

  useEffect(() => {
    if (hydrated && !token) router.replace(loginRedirectHref());
  }, [hydrated, token, router]);

  if (!hydrated || !token) return <div className="skeleton" style={{ height: 320, width: "100%" }} />;
  return <HoursBoard vendorId={params.vendorId} branchId={params.branchId} />;
}
