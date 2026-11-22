"use client";

import { useParams } from "next/navigation";
import ProductDetailView from "@/components/product-detail/ProductDetailView";

// The in-store product page. Phase A++ (item 3): its body is the shared
// ProductDetailView, which the owner's «معاينة» of a draft renders too.
export default function StoreProductPage() {
  const params = useParams<{ slug: string; offerId: string }>();
  return <ProductDetailView source={{ mode: "live", slug: params.slug, offerId: params.offerId }} />;
}
