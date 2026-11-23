"use client";

import { useSearchParams } from "next/navigation";
import BranchToolRedirect from "@/components/owner/BranchToolRedirect";

/**
 * The owner's old «طلبات كل الفروع» list is the «كل الفروع» scope of the
 * branch orders board now (the employee: the own branch's orders). An
 * ?order= from an older link is kept.
 */
export default function OrdersRedirect() {
  const sp = useSearchParams();
  const order = sp.get("order");
  const query = order && /^[0-9a-f-]{36}$/i.test(order) ? `order=${order}` : "";
  return <BranchToolRedirect tool="orders" query={query} ownerQuery="scope=all" testId="orders-redirect" />;
}
