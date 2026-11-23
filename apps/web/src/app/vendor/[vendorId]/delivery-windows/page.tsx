"use client";

import BranchToolRedirect from "@/components/owner/BranchToolRedirect";

/**
 * «نوافذ التوصيل v1»: the old store-level address opens the «التوصيل» tab of
 * «إدارة الفروع» (the employee's own branch, or the owner's current one).
 */
export default function DeliveryWindowsRedirectPage() {
  return <BranchToolRedirect tool="delivery-windows" testId="dw-redirect" />;
}
