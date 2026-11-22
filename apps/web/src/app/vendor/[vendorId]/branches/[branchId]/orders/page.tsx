"use client";

import { useParams, useRouter } from "next/navigation";
import { useEffect } from "react";
import BranchOrdersBoard from "@/components/branch-orders/BranchOrdersBoard";
import { loginRedirectHref } from "@/lib/loginRedirect";
import { useHydrated, useSessionToken } from "@/lib/useSession";

/**
 * «إدارة طلبات الفرع» (2026-11-22, v1): the branch's operating queue and the
 * chosen order (details, actions, activity) - see BranchOrdersBoard. The
 * actions are the existing staff endpoints, unchanged; the queue, the
 * details and the activity are the new read-only order-queue API.
 *
 * Owner: any of her branches (the dashboard switches to the order's branch).
 * Employee: her own branch only - another branch's link shows a safe
 * message (and the server refuses it anyway).
 */
export default function BranchOrdersPage() {
  const params = useParams<{ vendorId: string; branchId: string }>();
  const router = useRouter();
  const hydrated = useHydrated();
  const token = useSessionToken();

  useEffect(() => {
    if (hydrated && !token) router.replace(loginRedirectHref());
  }, [hydrated, token, router]);

  if (!hydrated || !token) return <div className="skeleton" style={{ height: 320, width: "100%" }} />;
  return <BranchOrdersBoard vendorId={params.vendorId} branchId={params.branchId} />;
}
