"use client";

import StoreSettingsRedirect from "@/components/owner/StoreSettingsRedirect";

/** «سياسة الإرجاع» moved into «إعدادات المتجر»: the old address opens it there. */
export default function ReturnPolicyRedirect() {
  return <StoreSettingsRedirect section="returns" testId="policy-redirect" />;
}
