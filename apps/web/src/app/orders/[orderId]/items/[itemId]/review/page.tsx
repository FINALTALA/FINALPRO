"use client";

import Link from "next/link";
import { useParams, useRouter, useSearchParams } from "next/navigation";
import { Suspense, useEffect, useState } from "react";
import ReviewComposer, { type ComposerTarget } from "@/components/ReviewComposer";
import { ErrorBanner } from "@/components/States";
import { apiFetch } from "@/lib/api";
import { reviewErrorMessageIn } from "@/lib/reviews";
import { useHydrated, useSessionToken } from "@/lib/useSession";
import { registerTranslations, translate } from "@/lib/i18n";
import { useLang } from "@/lib/useLang";
import { apiErrorMessage } from "@/lib/apiErrors";
import { useTaxonomy } from "@/lib/taxonomy";
import { colorName, pickText, sizeName } from "@/lib/localized";
import { fmt } from "@/lib/shopText";
import { loginRedirectHref } from "@/lib/loginRedirect";

// TB-25: this page's own words (Arabic unchanged).
registerTranslations({
  ar: {
    "wrv.not_found": "لم يُعثر على هذا المنتج ضمن طلباتك.",
    "wrv.not_eligible": "لا يمكن تقييم هذا المنتج قبل اكتمال الطلب فعلياً (توصيل أو استلام).",
    "wrv.deleted": "حذفتِ هذا التقييم، ولا يمكن كتابة تقييم بديل لنفس الطلب.",
    "wrv.hidden": "أخفت الإدارة هذا التقييم.",
    "wrv.color": "اللون: {v}",
    "wrv.size": "المقاس: {v}",
    "wrv.my_orders": "طلباتي",
  },
  en: {
    "wrv.not_found": "This product wasn't found in your orders.",
    "wrv.not_eligible": "This product can't be reviewed until the order is actually completed (delivered or picked up).",
    "wrv.deleted": "You deleted this review, and a replacement can't be written for the same order.",
    "wrv.hidden": "The platform hid this review.",
    "wrv.color": "Colour: {v}",
    "wrv.size": "Size: {v}",
    "wrv.my_orders": "My orders",
  },
});

interface OrderItemReview {
  eligible: boolean;
  product_reviewable: boolean;
  product: { id: string; deleted: boolean; hidden: boolean } | null;
  store: { id: string; deleted: boolean; hidden: boolean } | null;
}
interface OrderSummary {
  id: string;
  vendor_display_name: string;
  items: {
    id: string;
    title_ar: string;
    title_en?: string;
    color_label?: string | null;
    size_label?: string | null;
    color_code?: string | null;
    size_code?: string | null;
    review?: OrderItemReview;
  }[];
}

// PD-3: a direct link to one purchased item's review (old links, the
// review-invitation notification). It opens the same panel «طلباتي»
// uses - create, or edit when this item already has a review of that
// kind - and returns to «طلباتي» when closed. Eligibility is still
// decided only by the API. `?target=STORE` reviews the store instead.
export default function WriteReviewPage() {
  return (
    <Suspense fallback={<div className="page-shell" />}>
      <WriteReview />
    </Suspense>
  );
}

function WriteReview() {
  const params = useParams<{ orderId: string; itemId: string }>();
  const search = useSearchParams();
  const router = useRouter();
  const hydrated = useHydrated();
  const token = useSessionToken();
  const [target, setTarget] = useState<ComposerTarget | null>(null);
  const lang = useLang();
  const t = (key: string) => translate(lang, key);
  const taxonomy = useTaxonomy().data;
  // TB-25: a key of this page's words, or an API failure - worded at render.
  const [error, setError] = useState<{ key: string } | { api: unknown } | null>(null);
  const kind = search.get("target") === "STORE" ? "STORE" : "PRODUCT";
  const back = "/cart?tab=orders";

  useEffect(() => {
    if (!hydrated) return;
    if (!token) {
      router.replace(loginRedirectHref());
      return;
    }
    apiFetch<OrderSummary[]>("/customers/me/orders")
      .then((orders) => {
        const order = orders.find((o) => o.id === params.orderId);
        const item = order?.items.find((i) => i.id === params.itemId);
        if (!order || !item?.review) {
          setError({ key: "wrv.not_found" });
          return;
        }
        if (!item.review.eligible) {
          setError({ key: "wrv.not_eligible" });
          return;
        }
        const useStore = kind === "STORE" || !item.review.product_reviewable;
        const slot = useStore ? item.review.store : item.review.product;
        if (slot?.deleted || slot?.hidden) {
          setError({ key: slot.deleted ? "wrv.deleted" : "wrv.hidden" });
          return;
        }
        setTarget(
          slot
            ? { mode: "edit", reviewId: slot.id }
            : {
                mode: "create",
                itemId: item.id,
                target: useStore ? "STORE" : "PRODUCT",
                title: useStore ? order.vendor_display_name : pickText(lang, item.title_en, item.title_ar),
                purchased: (() => {
                  const color = colorName(taxonomy, item.color_code, lang, item.color_label ?? null);
                  const size = item.size_code ? sizeName(item.size_code, item.size_label, lang) : item.size_label ?? null;
                  return [color && fmt(t("wrv.color"), { v: color }), size && fmt(t("wrv.size"), { v: size })].filter(Boolean).join(" · ") || null;
                })(),
              },
        );
      })
      .catch((err) => setError({ api: err }));
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the words follow `lang` at render; the panel is opened once
  }, [hydrated, token, params.orderId, params.itemId, kind, router]);

  return (
    <div className="page-shell">
      {error && (
        <>
          <ErrorBanner message={"key" in error ? t(error.key) : reviewErrorMessageIn(error.api, lang, (e) => apiErrorMessage(e, lang))} />
          <Link href={back} className="button" style={{ marginTop: 12 }}>{t("wrv.my_orders")}</Link>
        </>
      )}
      {!error && !target && <div className="skeleton" style={{ height: 200, width: "100%", maxWidth: 560 }} />}
      {target && (
        <ReviewComposer target={target} onClose={() => router.replace(back)} onSaved={() => undefined} />
      )}
    </div>
  );
}
