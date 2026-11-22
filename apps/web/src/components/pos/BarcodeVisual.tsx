"use client";

import JsBarcode from "jsbarcode";
import Link from "next/link";
import { useEffect, useRef } from "react";
import { usePrintList, type PrintItem } from "@/lib/printList";
import "@/lib/storePosText";
import { useT } from "@/lib/useLang";

const JS_FORMAT = { EAN13: "EAN13", EAN8: "EAN8", UPCA: "UPC", CODE128: "CODE128" } as const;

/**
 * A barcode as real, scannable bars (SVG) with its digits underneath - the
 * same drawing on screen, in the preview and on paper.
 */
export function BarcodeVisual({
  code,
  format,
  height = 40,
  className = "pos-barcode-visual",
}: {
  code: string;
  format: PrintItem["format"];
  height?: number;
  className?: string;
}) {
  const ref = useRef<SVGSVGElement>(null);
  useEffect(() => {
    if (!ref.current) return;
    try {
      JsBarcode(ref.current, code, {
        format: JS_FORMAT[format],
        displayValue: true,
        margin: 0,
        height,
        width: format === "CODE128" && code.length > 14 ? 1 : 1.4,
        fontSize: 12,
        textMargin: 1,
        background: "#ffffff",
        lineColor: "#000000",
      });
    } catch {
      // a code its format refuses (cannot happen for a stored code) - left blank
    }
  }, [code, format, height]);
  return <svg ref={ref} className={className} role="img" aria-label={code} data-testid="barcode-svg" />;
}

/** X-dimension of a retail barcode at 100% (EAN-13 / UPC-A nominal module). */
export const NOMINAL_MODULE_MM = 0.33;

/**
 * A label's bars at their real printed size: one module = 0.33 mm (EAN-13 at
 * 100% magnification, the size scanners are made for), shortened in height
 * only (allowed for retail scanning) and never squeezed below that width
 * unless a long Code 128 must fit the label - then the widest module that
 * fits. The digits are printed by the label itself, under the bars.
 */
export function LabelBarcode({
  code,
  format,
  heightMm = 12,
  maxWidthMm = 44,
}: {
  code: string;
  format: PrintItem["format"];
  heightMm?: number;
  maxWidthMm?: number;
}) {
  const ref = useRef<SVGSVGElement>(null);
  useEffect(() => {
    const svg = ref.current;
    if (!svg) return;
    try {
      JsBarcode(svg, code, { format: JS_FORMAT[format], displayValue: false, margin: 0, width: 1, height: 100, background: "#ffffff", lineColor: "#000000" });
      const modules = parseFloat(svg.getAttribute("width") ?? "") || 95;
      const moduleMm = Math.min(NOMINAL_MODULE_MM, maxWidthMm / modules);
      svg.setAttribute("viewBox", `0 0 ${modules} 100`);
      svg.setAttribute("width", `${(modules * moduleMm).toFixed(2)}mm`);
      svg.setAttribute("height", `${heightMm}mm`);
      svg.setAttribute("preserveAspectRatio", "none");
      svg.setAttribute("shape-rendering", "crispEdges");
      svg.dataset.modules = String(modules);
      svg.dataset.moduleMm = moduleMm.toFixed(3);
    } catch {
      // a code its format refuses (cannot happen for a stored code) - left blank
    }
  }, [code, format, heightMm, maxWidthMm]);
  return <svg ref={ref} className="lb-bars" role="img" aria-label={code} data-testid="barcode-svg" />;
}

/**
 * Right after «إنشاء باركود من النظام»: the code as bars and digits, ONE clear
 * «إضافة إلى قائمة الطباعة» (this device's print list) that turns into «مضاف
 * إلى قائمة الطباعة ✓», and beside it a quiet «فتح صفحة الطباعة».
 */
export function GeneratedBarcodeCard({
  vendorId,
  item,
  onGoToPrint,
}: {
  vendorId: string;
  item: Omit<PrintItem, "copies" | "selected">;
  /** inside the management panel: open the print screen there (else its page) */
  onGoToPrint?: () => void;
}) {
  const t = useT();
  const list = usePrintList(vendorId);
  const inList = list.has(item.code);
  return (
    <div className="pos-generated" data-testid="generated-barcode">
      <div className="pos-generated-visual">
        <BarcodeVisual code={item.display_code} format={item.format} height={48} />
      </div>
      <div className="pos-generated-side">
        <p className="pos-generated-code">
          <span className="pos-code-number" dir="ltr" data-testid="generated-code">{item.display_code}</span>
          <span className="pos-tag pos-tag-sand">{t("bc.source.GENERATED")}</span>
        </p>
        <div className="pos-generated-actions">
          {inList ? (
            <span className="pos-added" role="status" data-testid="generated-add-to-print" data-added="true">
              <span aria-hidden="true">✓</span> {t("pl.added")}
            </span>
          ) : (
            <button type="button" className="pos-btn pos-btn-secondary" disabled={!list.ready} onClick={() => list.add([item])} data-testid="generated-add-to-print" data-added="false">
              {t("pl.add_btn")}
            </button>
          )}
          {onGoToPrint ? (
            <button type="button" className="pos-link-btn" onClick={onGoToPrint} data-testid="generated-go-print">
              {t("pl.open")}
            </button>
          ) : (
            <Link href={`/vendor/${vendorId}/labels`} className="pos-link-btn" data-testid="generated-go-print">
              {t("pl.open")}
            </Link>
          )}
        </div>
      </div>
    </div>
  );
}
