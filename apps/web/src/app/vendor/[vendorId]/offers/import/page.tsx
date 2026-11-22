"use client";

import { useParams } from "next/navigation";
import { ImportView } from "@/components/owner/ImportView";

/**
 * «استيراد منتجات من ملف» as its own page (a direct link). From
 * «المنتجات والعروض» the same view opens inside the workspace's large panel
 * instead - see ManagePanel.
 */
export default function ImportOffersPage() {
  const params = useParams<{ vendorId: string }>();
  return <ImportView vendorId={params.vendorId} />;
}
