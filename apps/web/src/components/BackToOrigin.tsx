"use client";

import { usePathname, useRouter } from "next/navigation";
import { type MouseEvent, useState } from "react";
import { BackIcon } from "@/components/Icons";
import { backLabel, originFor, rememberReturnFocus, routeBefore } from "@/lib/navTrail";

/**
 * A fixed arrow (top-left) back to the page this one was entered from -
 * e.g. the /men, /women or /kids listing, with its filters. A real
 * browser Back when that page is the previous history entry (so the
 * listing comes back exactly as left), otherwise a navigation to it;
 * home when the page was opened directly. With `focusProductId`, the
 * listing lands on that product's card (ReturnFocus).
 */
export default function BackToOrigin({ focusProductId }: { focusProductId?: string }) {
  const router = useRouter();
  const pathname = usePathname();
  // Read once per visit (the trail lives in this tab's sessionStorage).
  const [origin] = useState(() => (typeof window === "undefined" ? null : originFor(pathname)));
  const label = backLabel(origin);

  function goBack(event: MouseEvent<HTMLAnchorElement>) {
    // A modified click (new tab/window) keeps the plain link.
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0) return;
    event.preventDefault();
    // The listing then scrolls to this product's card.
    if (focusProductId) rememberReturnFocus(focusProductId);
    if (origin && routeBefore(pathname) === origin && window.history.length > 1) {
      router.back();
      return;
    }
    router.push(origin ?? "/");
  }

  // A real link, so it works even before the page has hydrated.
  return (
    <a
      href={origin ?? "/"}
      className="back-to-origin"
      onClick={goBack}
      aria-label={label}
      title={label}
      suppressHydrationWarning
    >
      <BackIcon />
    </a>
  );
}
