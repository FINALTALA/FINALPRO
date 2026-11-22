"use client";

import { useEffect, useState } from "react";
import { onToast, type ToastMessage } from "@/lib/toast";
import { useT } from "@/lib/useLang";

/**
 * The shell's small temporary messages (lib/toast.ts): at the top centre,
 * above the management window, no backdrop. Announced politely (an error
 * assertively); a warning or an error can also be closed by hand.
 */
export default function Toaster() {
  const t = useT();
  const [items, setItems] = useState<ToastMessage[]>([]);
  useEffect(
    () =>
      onToast((m) => {
        setItems((xs) => [...xs.slice(-2), m]);
        window.setTimeout(() => setItems((xs) => xs.filter((x) => x.id !== m.id)), m.duration);
      }),
    [],
  );
  return (
    <div className="toaster" aria-live="polite" aria-atomic="false">
      {items.map((m) => (
        <div key={m.id} className={`toast toast-${m.tone}`} role={m.tone === "error" ? "alert" : "status"} data-testid="toast">
          <span className="toast-text">{m.text}</span>
          {m.tone !== "success" && (
            <button type="button" className="toast-close" onClick={() => setItems((xs) => xs.filter((x) => x.id !== m.id))} aria-label={t("toast.close")}>
              ×
            </button>
          )}
        </div>
      ))}
    </div>
  );
}
