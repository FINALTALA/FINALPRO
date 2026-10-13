"use client";

import { useEffect, useSyncExternalStore } from "react";
import { apiFetch } from "./api";
import { LANG_EVENT, Lang, getLang, setLang, translate } from "./i18n";

function subscribe(onChange: () => void): () => void {
  window.addEventListener(LANG_EVENT, onChange);
  window.addEventListener("storage", onChange);
  return () => {
    window.removeEventListener(LANG_EVENT, onChange);
    window.removeEventListener("storage", onChange);
  };
}

/** The current UI language - "ar" on the server/first paint, matching layout.tsx's static lang="ar". */
export function useLang(): Lang {
  return useSyncExternalStore(subscribe, getLang, () => "ar");
}

/** `t("some.key")` bound to the current language. */
export function useT(): (key: string) => string {
  const lang = useLang();
  return (key: string) => translate(lang, key);
}

/**
 * Sprint 22: once per sign-in, pulls the account's server-persisted
 * language_pref (User.languagePref) and applies it locally if it
 * differs from this browser's current choice - so a preference set on
 * one device follows the customer to the next. Only runs when a
 * session token is present; a signed-out visitor keeps whatever this
 * browser last chose (or the "ar" default).
 */
export function useSyncServerLanguagePref(token: string | null): void {
  useEffect(() => {
    if (!token) return;
    let cancelled = false;
    apiFetch<{ language_pref: Lang | null }>("/customers/me")
      .then((res) => {
        if (!cancelled && (res.language_pref === "ar" || res.language_pref === "en")) {
          if (res.language_pref !== getLang()) setLang(res.language_pref);
        }
      })
      .catch(() => {
        // Not a customer account, or offline - this browser's existing
        // choice (or the "ar" default) stands.
      });
    return () => {
      cancelled = true;
    };
  }, [token]);
}
