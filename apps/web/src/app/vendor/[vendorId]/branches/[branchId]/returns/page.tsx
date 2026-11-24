"use client";

import { useParams, useRouter } from "next/navigation";
import { useEffect } from "react";
import ReturnsBoard from "@/components/branch-returns/ReturnsBoard";
import { loginRedirectHref } from "@/lib/loginRedirect";
import { useHydrated, useSessionToken } from "@/lib/useSession";

/**
 * «الإرجاعات» of «إدارة الفروع» - IX-P2 «لوحة إرجاعات الفرع» (2026-11-23):
 * the branch's returns board (tabs, search, filters, one return with its
 * activity, approve / reject) and «استلام إرجاع» (one entry for the code:
 * typed, a scanner or the camera; a safe preview; the existing redemption).
 * The store's return policy stays a read-only line at the top.
 *
 * Owner: «هذا الفرع | كل الفروع». Employee: her own branch only (another
 * branch's link shows a safe message; the server refuses it anyway).
 * Old addresses: ?redeem=1 and /vendor/:id/returns/redeem open «استلام إرجاع».
 */
export default function BranchReturnsPage() {
  const params = useParams<{ vendorId: string; branchId: string }>();
  const router = useRouter();
  const hydrated = useHydrated();
  const token = useSessionToken();
  useEffect(() => {
    if (hydrated && !token) router.replace(loginRedirectHref());
  }, [hydrated, token, router]);
  if (!hydrated || !token) return <div className="skeleton" style={{ height: 320, width: "100%" }} />;
  return <ReturnsBoard vendorId={params.vendorId} branchId={params.branchId} />;
}
