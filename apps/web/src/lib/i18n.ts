"use client";

// Sprint 22 (FR-AUTH-009/NFR-L10N-001): the i18n foundation. Scope is
// deliberately narrow - this dictionary (and the lang/dir switching it
// drives) only covers AppShell, other shared UI, and S22's own new
// screens. Every pre-S22 screen's body content stays Arabic-only and
// untranslated by design (not an oversight) - retranslating the whole
// S1-S21b surface was explicitly out of scope for this sprint.
//
// Storage/event pattern mirrors session.ts exactly: localStorage for
// the per-browser preference, a same-tab custom event so every
// subscriber (AppShell, the <html> lang/dir effect) updates
// immediately without a reload. For a signed-in customer the
// preference is ALSO persisted server-side (User.languagePref, via
// PATCH /customers/me) and read back on login - see useLang.ts's
// useSyncServerLanguagePref() - so it survives a new browser/device,
// not just this one.
export type Lang = "ar" | "en";

const LANG_KEY = "finalpro_lang_pref";
export const LANG_EVENT = "finalpro:lang";

function notifyLangChanged(): void {
  try {
    window.dispatchEvent(new Event(LANG_EVENT));
  } catch {
    // Not in a browser (SSR) - nothing to notify.
  }
}

export function getLang(): Lang {
  try {
    return localStorage.getItem(LANG_KEY) === "en" ? "en" : "ar";
  } catch {
    return "ar";
  }
}

export function setLang(lang: Lang): void {
  try {
    localStorage.setItem(LANG_KEY, lang);
    notifyLangChanged();
  } catch {
    // Private-browsing/blocked storage: the choice still applies for
    // this page load via in-memory state, just won't survive a reload.
  }
}

// English mode falls back to the original (Arabic) text for any
// bilingual data field (e.g. offer/variant titleEn/nameEn) whose
// English value is absent - this dictionary covers static UI text
// only, never vendor-authored content.
export function withEnglishFallback(
  lang: Lang,
  en: string | null | undefined,
  original: string,
): string {
  return lang === "en" && en ? en : original;
}

const DICT: Record<Lang, Record<string, string>> = {
  ar: {
    "nav.home": "الرئيسية",
    "nav.discover": "اكتشف",
    "nav.cart": "السلة",
    "nav.orders": "طلباتي",
    "nav.following": "أتابعه",
    "nav.account": "حسابي",

    "appshell.announcement": "متاجر محلية في مكان واحد · مقارنة واضحة للسعر والتوفّر",
    "appshell.nav.primary_aria": "التنقل الرئيسي",
    "appshell.nav.bottom_aria": "التنقل السفلي",
    "appshell.search.placeholder": "ابحث عن منتج أو متجر",
    "appshell.search.submit_aria": "بحث",
    "appshell.notifications_aria": "الإشعارات",
    "appshell.account_menu_aria": "الحساب ومساحات العمل",
    "appshell.workspaces_title": "مساحات العمل",
    "appshell.badge.suspended": "معلّق",
    "appshell.badge.active": "نشطة",
    "appshell.sign_out": "تسجيل الخروج",
    "appshell.sign_in": "دخول",
    "appshell.sign_up": "إنشاء حساب",

    "common.loading": "جارٍ التحميل...",
    "common.save": "حفظ",
    "common.cancel": "إلغاء",
    "common.saving": "جارٍ الحفظ...",
    "common.back": "رجوع",
    "common.close": "إغلاق",
  },
  en: {
    "nav.home": "Home",
    "nav.discover": "Discover",
    "nav.cart": "Cart",
    "nav.orders": "Orders",
    "nav.following": "Following",
    "nav.account": "Account",

    "appshell.announcement": "Local stores in one place · clear price and availability comparison",
    "appshell.nav.primary_aria": "Primary navigation",
    "appshell.nav.bottom_aria": "Bottom navigation",
    "appshell.search.placeholder": "Search for a product or store",
    "appshell.search.submit_aria": "Search",
    "appshell.notifications_aria": "Notifications",
    "appshell.account_menu_aria": "Account and workspaces",
    "appshell.workspaces_title": "Workspaces",
    "appshell.badge.suspended": "Suspended",
    "appshell.badge.active": "Active",
    "appshell.sign_out": "Sign out",
    "appshell.sign_in": "Sign in",
    "appshell.sign_up": "Sign up",

    "common.loading": "Loading...",
    "common.save": "Save",
    "common.cancel": "Cancel",
    "common.saving": "Saving...",
    "common.back": "Back",
    "common.close": "Close",
  },
};

/**
 * Merges extra namespaced keys into the base dictionary - used by each
 * S22 screen to register its own strings without growing this shared
 * file indefinitely. Call once per module at import time (idempotent:
 * re-assigning the same key is harmless).
 */
export function registerTranslations(extra: Record<Lang, Record<string, string>>): void {
  Object.assign(DICT.ar, extra.ar);
  Object.assign(DICT.en, extra.en);
}

/** Falls back to Arabic, then to the raw key - a missing key is always visible text, never a crash. */
export function translate(lang: Lang, key: string): string {
  return DICT[lang]?.[key] ?? DICT.ar[key] ?? key;
}
