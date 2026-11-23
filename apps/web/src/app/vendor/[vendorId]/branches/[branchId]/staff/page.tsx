"use client";

import { useParams, useRouter } from "next/navigation";
import { useEffect } from "react";
import StaffBoard from "@/components/owner/StaffBoard";
import { loginRedirectHref } from "@/lib/loginRedirect";
import "@/lib/staffText";
import { useHydrated, useSessionToken } from "@/lib/useSession";

/** «الموظفون» - the owner's tab of «إدارة الفروع» (see StaffBoard). */
export default function BranchStaffPage() {
  const params = useParams<{ vendorId: string; branchId: string }>();
  const router = useRouter();
  const hydrated = useHydrated();
  const token = useSessionToken();
  useEffect(() => {
    if (hydrated && !token) router.replace(loginRedirectHref());
  }, [hydrated, token, router]);
  if (!hydrated || !token) return <div className="skeleton" style={{ height: 200, width: "100%" }} />;
  return <StaffBoard vendorId={params.vendorId} branchId={params.branchId} />;
}
