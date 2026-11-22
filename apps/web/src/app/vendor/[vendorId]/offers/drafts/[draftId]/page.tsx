"use client";

import { useParams } from "next/navigation";
import { ProductWizard } from "@/components/product-wizard/ProductWizard";

// A direct link to one draft: the same wizard as the store's panel, on its
// own page (the panel is opened from the storefront and the products table).
export default function DraftWizardPage() {
  const params = useParams<{ vendorId: string; draftId: string }>();
  return <ProductWizard vendorId={params.vendorId} draftId={params.draftId} mode="page" />;
}
