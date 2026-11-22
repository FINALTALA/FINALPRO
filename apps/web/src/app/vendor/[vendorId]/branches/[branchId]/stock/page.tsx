"use client";

import { useParams, useRouter } from "next/navigation";
import { useEffect } from "react";
import StockBoard from "@/components/branch-stock/StockBoard";
import { loginRedirectHref } from "@/lib/loginRedirect";
import { useHydrated, useSessionToken } from "@/lib/useSession";

/**
 * «إدارة مخزون الفرع» (2026-11-22, v1): the branch's stock board - summary,
 * search, filters, the list, the chosen line (numbers, threshold, the safe
 * movements, its log) - see StockBoard. Owner: any branch; employee: her
 * own branch only (another branch's link shows a safe message, and the
 * server refuses it anyway). No manual sale: a sale is the cashier's.
 */
export default function BranchStockPage() {
  const params = useParams<{ vendorId: string; branchId: string }>();
  const router = useRouter();
  const hydrated = useHydrated();
  const token = useSessionToken();

  useEffect(() => {
    if (hydrated && !token) router.replace(loginRedirectHref());
  }, [hydrated, token, router]);

  if (!hydrated || !token) return <div className="skeleton" style={{ height: 320, width: "100%" }} />;
  return <StockBoard vendorId={params.vendorId} branchId={params.branchId} />;
}
