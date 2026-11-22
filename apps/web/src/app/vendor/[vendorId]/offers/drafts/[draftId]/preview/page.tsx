"use client";

import { useParams } from "next/navigation";
import ProductDetailView from "@/components/product-detail/ProductDetailView";

// Phase A++ (item 3): «معاينة» - the owner sees the draft exactly as the
// shopper's product page will show it once published (the same view, in
// preview mode: a «معاينة — غير منشور» strip, every action switched off).
export default function DraftPreviewPage() {
  const params = useParams<{ vendorId: string; draftId: string }>();
  return <ProductDetailView source={{ mode: "preview", vendorId: params.vendorId, draftId: params.draftId }} />;
}
