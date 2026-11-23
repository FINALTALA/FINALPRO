"use client";

import BranchToolRedirect from "@/components/owner/BranchToolRedirect";

/**
 * «الموظفون» is a tab of «إدارة الفروع» now (owner only): the old store-level
 * address opens it on the current branch with «كل الموظفين» - what this page
 * used to list. An employee lands on the tab's own owner-only refusal.
 */
export default function StaffRedirect() {
  return <BranchToolRedirect tool="staff" ownerQuery="scope=all" testId="staff-redirect" />;
}
