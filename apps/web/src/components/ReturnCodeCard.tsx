"use client";

import JsBarcode from "jsbarcode";
import { useEffect, useRef } from "react";

/**
 * IX-P2: the shopper's OWN return / exchange code at the counter - large,
 * spaced digits (read aloud or typed) and the same digits as CODE128 bars
 * (read by the store's scanner or camera). Rendered only on the shopper's
 * own return page, from her own customer-scoped route; no store screen ever
 * receives the code (IX-P1). The bars are decorative for a screen reader:
 * the digits are the text.
 */
export default function ReturnCodeCard({ code, label, hint }: { code: string; label: string; hint: string }) {
  const ref = useRef<SVGSVGElement>(null);
  useEffect(() => {
    if (!ref.current) return;
    try {
      JsBarcode(ref.current, code, {
        format: "CODE128",
        displayValue: false,
        margin: 8,
        height: 64,
        width: 2.4,
        background: "#ffffff",
        lineColor: "#000000",
      });
    } catch {
      // a 6-digit code is always valid CODE128; nothing to draw otherwise
    }
  }, [code]);
  return (
    <div className="return-code-card" data-testid="return-code-card">
      <p className="return-code-label">{label}</p>
      <p className="return-code-digits" dir="ltr" data-testid="return-code-digits">
        {code}
      </p>
      <svg ref={ref} className="return-code-bars" aria-hidden="true" data-testid="return-code-barcode" />
      <p className="return-code-hint">{hint}</p>
    </div>
  );
}
