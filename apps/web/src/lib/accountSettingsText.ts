import { registerTranslations } from "./i18n";

// «إعدادات المستخدم» (2026-11-24): the account's own settings inside the
// current personal page (/profile) - one account for shopping and for any
// store / branch work, so these are never store settings.

/** The personal page in its settings view. */
export const SETTINGS_HREF = "/profile?view=settings";

registerTranslations({
  ar: {
    "us.open": "الإعدادات",
    "us.title": "إعدادات المستخدم",
    "us.lead": "إعدادات حسابك الشخصي - الحساب نفسه للتسوّق ولعملك في متجر أو فرع.",
    "us.back": "رجوع إلى صفحتي",
    "us.group.shopping": "التسوّق",
    "us.addresses": "عناويني",
    "us.addresses_hint": "إدارة العناوين: إضافتها وتعديلها وحذفها",
    "us.alerts": "تنبيهات عودة التوفر",
    "us.alerts_hint": "الألوان والمقاسات التي تنتظرينها",
    "us.group.account": "الحساب والأمان",
    "us.phone": "رقم الهاتف",
    "us.phone_change": "تغيير",
    "us.signout": "تسجيل الخروج",
    "us.signout_hint": "من التسوّق ومن أي متجر أو فرع على هذا الجهاز",
    "us.signing_out": "جارٍ تسجيل الخروج…",
    "us.close": "إغلاق الحساب",
    "us.close_hint": "تعطيل حسابك",
  },
  en: {
    "us.open": "Settings",
    "us.title": "User settings",
    "us.lead": "Your personal account's settings - the same account for shopping and for your work at a store or branch.",
    "us.back": "Back to my page",
    "us.group.shopping": "Shopping",
    "us.addresses": "My addresses",
    "us.addresses_hint": "Manage your addresses: add, edit and delete",
    "us.alerts": "Back-in-stock alerts",
    "us.alerts_hint": "The colours and sizes you are waiting for",
    "us.group.account": "Account and security",
    "us.phone": "Phone number",
    "us.phone_change": "Change",
    "us.signout": "Sign out",
    "us.signout_hint": "From shopping and from any store or branch on this device",
    "us.signing_out": "Signing out…",
    "us.close": "Close the account",
    "us.close_hint": "Deactivate your account",
  },
});
