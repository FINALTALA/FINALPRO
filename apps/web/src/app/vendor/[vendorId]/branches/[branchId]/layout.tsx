"use client";

import { useParams, usePathname } from "next/navigation";
import { useEffect, type ReactNode } from "react";
import { BRANCH_TABS, BranchShell, useBranchWorkspace, writeCurrentBranch, type BranchTab, type BranchView } from "@/components/owner/BranchWorkspace";
import "@/lib/branchesText";

/**
 * Every view of one branch («نظرة عامة» and its tools: orders, stock,
 * delivery windows, hours, returns; «إعدادات الفرع» from the header) inside the same
 * branch dashboard: the context header and the tools bar stay, only the work
 * area changes. The tools are the existing pages, unchanged (their own title
 * and cross-links give way to the bar). Another branch's employee gets the
 * screen alone (its own server refusal, unchanged).
 */
export default function BranchLayout({ children }: { children: ReactNode }) {
  const params = useParams<{ vendorId: string; branchId: string }>();
  const pathname = usePathname();
  const ws = useBranchWorkspace(params.vendorId);
  const seg = pathname.split("/")[5] as BranchTab | undefined;
  // «إعدادات الفرع» is a screen of this dashboard (header action), not a tab
  const view: BranchView = (seg as string) === "settings" ? "settings" : seg && BRANCH_TABS.includes(seg) ? seg : "overview";
  const branch = ws.branches?.find((b) => b.id === params.branchId) ?? null;
  const foreign = ws.ready && !ws.isOwner && ws.ownBranchId !== params.branchId;

  useEffect(() => {
    if (ws.isOwner && branch && !branch.archived_at) writeCurrentBranch(params.vendorId, branch.id);
  }, [ws.isOwner, branch, params.vendorId]);

  if (foreign) return <>{children}</>;
  return (
    <BranchShell vendorId={params.vendorId} ws={ws} current={branch} view={view}>
      {children}
    </BranchShell>
  );
}
