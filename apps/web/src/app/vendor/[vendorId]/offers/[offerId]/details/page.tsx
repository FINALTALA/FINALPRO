"use client";

import { useParams } from "next/navigation";
import { OfferDetailsView } from "@/components/owner/OfferDetailsView";

/**
 * The owner's product details as its own page (a direct link, a new tab).
 * From «المنتجات والعروض» the same view opens inside the workspace's large
 * panel instead - see ManagePanel.
 */
export default function OfferDetailsPage() {
  const params = useParams<{ vendorId: string; offerId: string }>();
  return <OfferDetailsView vendorId={params.vendorId} offerId={params.offerId} />;
}
