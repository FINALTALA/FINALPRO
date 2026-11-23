"use client";

import StoreSettingsRedirect from "@/components/owner/StoreSettingsRedirect";

/** «مناطق ورسوم التوصيل» moved into «إعدادات المتجر»: the old address opens it there. */
export default function DeliveryZonesRedirect() {
  return <StoreSettingsRedirect section="delivery" testId="zones-redirect" />;
}
