"use client";

import PerformanceRedirect from "@/components/owner/PerformanceRedirect";

/** «تقييمات العملاء» is the «العملاء» view of «أداء المتجر» now: the old address opens it. */
export default function OwnerReviewsRedirect() {
  return <PerformanceRedirect view="customers" testId="reviews-redirect" />;
}
