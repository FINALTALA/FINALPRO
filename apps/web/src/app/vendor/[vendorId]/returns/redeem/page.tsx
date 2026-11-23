"use client";

import BranchToolRedirect from "@/components/owner/BranchToolRedirect";

/**
 * «استبدال كود إرجاع» is an action of the branch's returns now: the old
 * address opens it there (the employee's own branch, or the owner's current
 * one - the receiving branch).
 */
export default function RedeemReturnRedirect() {
  return <BranchToolRedirect tool="returns" query="redeem=1" testId="redeem-redirect" />;
}
