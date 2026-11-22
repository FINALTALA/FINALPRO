"use client";

import { useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { registerTranslations } from "@/lib/i18n";
import { useLang, useT } from "@/lib/useLang";
import styles from "./product-reel-viewer.module.css";

// A product's own reel (organic store video), opened only from the card's
// "watch it in a reel" action. Plays muted with the native controls (sound
// is the viewer's choice); the video keeps its proportions (contain, never
// cropped or stretched). Close: the button, Esc, or a click outside.

registerTranslations({
  ar: {
    "productReel.watch": "شاهديه بالريل",
    "productReel.dialog": "ريل المنتج: {name}",
    "productReel.close": "إغلاق",
    "productReel.error": "تعذّر تشغيل الفيديو.",
  },
  en: {
    "productReel.watch": "Watch the reel",
    "productReel.dialog": "Product reel: {name}",
    "productReel.close": "Close",
    "productReel.error": "The video couldn't be played.",
  },
});

export default function ProductReelViewer({ video, width, height, poster, name, onClose }: {
  video: string;
  width: number;
  height: number;
  poster?: string;
  /** The product's name, for the dialog's label. */
  name: string;
  onClose: () => void;
}) {
  const t = useT();
  const lang = useLang();
  const closeRef = useRef<HTMLButtonElement>(null);
  const errorRef = useRef<HTMLParagraphElement>(null);

  // Focus into the dialog, Esc closes, the page behind does not scroll;
  // focus goes back to the action that opened it.
  useEffect(() => {
    const before = document.activeElement as HTMLElement | null;
    closeRef.current?.focus();
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    const overflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = overflow;
      before?.focus?.({ preventScroll: true });
    };
  }, [onClose]);

  return createPortal(
    <div
      className={styles.backdrop}
      role="dialog"
      aria-modal="true"
      aria-label={t("productReel.dialog").replace("{name}", name)}
      dir={lang === "ar" ? "rtl" : "ltr"}
      onClick={onClose}
    >
      <div className={styles.frame} style={{ aspectRatio: `${width} / ${height}` }} onClick={(e) => e.stopPropagation()}>
        <video
          className={styles.video}
          src={video}
          poster={poster}
          autoPlay
          muted
          playsInline
          controls
          disablePictureInPicture
          onError={() => { if (errorRef.current) errorRef.current.hidden = false; }}
        />
        <p ref={errorRef} className={styles.error} role="alert" hidden>{t("productReel.error")}</p>
        <button ref={closeRef} type="button" className={styles.close} onClick={onClose} aria-label={t("productReel.close")}>
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M18 6 6 18M6 6l12 12" /></svg>
        </button>
      </div>
    </div>,
    document.body,
  );
}
