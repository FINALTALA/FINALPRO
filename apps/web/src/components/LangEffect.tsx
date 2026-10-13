"use client";

import { useEffect } from "react";
import { useLang } from "@/lib/useLang";

// Sprint 22: layout.tsx renders <html lang="ar" dir="rtl"> statically
// on the server (it has no access to this browser's stored
// preference), so switching to English after hydration means
// imperatively flipping those two attributes client-side - a plain
// effect, not a re-render of the server-rendered <html> element.
export default function LangEffect() {
  const lang = useLang();
  useEffect(() => {
    document.documentElement.lang = lang;
    document.documentElement.dir = lang === "en" ? "ltr" : "rtl";
  }, [lang]);
  return null;
}
