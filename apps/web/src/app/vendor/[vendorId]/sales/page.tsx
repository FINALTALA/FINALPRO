"use client";

import PerformanceRedirect from "@/components/owner/PerformanceRedirect";

/** «مبيعات آخر 30 يوماً» is the online part of «أداء المتجر» › «المبيعات» now: the old address opens it. */
export default function OwnerSalesRedirect() {
  return <PerformanceRedirect view="sales" hash="online" testId="sales-redirect" />;
}
