import { registerTranslations } from "./i18n";

// VIA phase 5 - the platform Media Library (app/admin/media).

registerTranslations({
  ar: {
    "ml.title": "مكتبة الوسائط",
    "ml.lead":
      "صور وفيديوهات المنصة للصفحة الرئيسية والرائج وصفحة الإعلانات والمجموعات. منفصلة عن صور المتاجر، ويُفحص محتواها الحقيقي عند الرفع.",
    "ml.forbidden": "هذه الصفحة لمدير المنصة فقط.",
    "ml.account": "حسابي",
    "ml.upload": "رفع ملف",
    "ml.upload_lead":
      "صور JPEG وPNG وWebP حتى 10 ميغابايت و40 ميغابكسل. فيديو MP4 (H.264، صوت AAC اختياري) أو WebM (VP8/VP9، صوت Opus اختياري) حتى 100 ميغابايت و120 ثانية و1920×1080 أو ما يقابله عموديًا.",
    "ml.file": "الملف",
    "ml.name": "الاسم (اختياري)",
    "ml.category": "التصنيف",
    "ml.uploading": "جارٍ الرفع والفحص…",
    "ml.uploaded": "رُفع الملف وتم فحصه.",
    "ml.search": "بحث بالاسم",
    "ml.f.category": "التصنيف",
    "ml.f.kind": "النوع",
    "ml.f.status": "الحالة",
    "ml.f.all": "الكل",
    "ml.apply": "تطبيق",
    "ml.cat.HOMEPAGE": "الصفحة الرئيسية",
    "ml.cat.TRENDING": "الرائج",
    "ml.cat.ADS": "صفحة الإعلانات",
    "ml.cat.COLLECTIONS": "المجموعات",
    "ml.kind.IMAGE": "صورة",
    "ml.kind.VIDEO": "فيديو",
    "ml.status.ACTIVE": "نشط",
    "ml.status.ARCHIVED": "مؤرشف",
    "ml.status.ALL": "الكل",
    "ml.status.PURGING": "قيد الحذف النهائي",
    "ml.empty": "لا توجد ملفات تطابق هذا البحث.",
    "ml.load_failed": "تعذّر التحميل.",
    "ml.retry": "إعادة المحاولة",
    "ml.load_more": "عرض المزيد",
    "ml.open": "فتح",
    "ml.used": "مستخدم في {n}",
    "ml.unused": "غير مستخدم",
    "ml.back": "← مكتبة الوسائط",
    "ml.not_found": "الملف غير موجود.",
    "ml.d.details": "التفاصيل",
    "ml.d.type": "النوع",
    "ml.d.size": "الحجم",
    "ml.d.dimensions": "الأبعاد",
    "ml.d.duration": "المدة",
    "ml.d.codecs": "الترميز",
    "ml.d.uploaded": "رُفع",
    "ml.d.uploader": "رفعه",
    "ml.d.validation": "الفحص",
    "ml.d.valid": "سليم",
    "ml.d.sha": "بصمة SHA-256",
    "ml.d.public_url": "الرابط العام الثابت",
    "ml.d.no_public": "لا رابط عام: الملف غير منشور في أي محتوى.",
    "ml.d.usage": "أين يُستخدم",
    "ml.d.usage_lead":
      "أي استخدام (مسودة أو مجدول أو منشور أو نسخة قابلة للاستعادة) يمنع الأرشفة والحذف النهائي. ستكتب هذه الاستخدامات أداة المحتوى في المرحلة 6.",
    "ml.d.no_usage": "غير مستخدم في أي محتوى.",
    "ml.usage.DRAFT": "مسودة",
    "ml.usage.SCHEDULED": "مجدول",
    "ml.usage.PUBLISHED": "منشور",
    "ml.usage.REVISION": "نسخة سابقة",
    "ml.d.actions": "الإجراءات",
    "ml.archive": "أرشفة",
    "ml.restore": "استعادة",
    "ml.purge": "حذف نهائي",
    "ml.archive_blocked": "لا يمكن الأرشفة: الملف مستخدم.",
    "ml.purge_when": "يمكن الحذف النهائي بعد 30 يومًا من الأرشفة: {at}.",
    "ml.purge_blocked": "الحذف النهائي غير متاح الآن.",
    "ml.confirm.archive.title": "تأكيد الأرشفة",
    "ml.confirm.archive.lead":
      "سيختفي الملف من قوائم الاختيار، ويمكن استعادته لاحقًا.",
    "ml.confirm.restore.title": "تأكيد الاستعادة",
    "ml.confirm.restore.lead": "سيعود الملف نشطًا.",
    "ml.confirm.purge.title": "تأكيد الحذف النهائي",
    "ml.confirm.purge.lead": "سيُحذف الملف وسجله نهائيًا. لا يمكن التراجع.",
    "ml.confirm.ok": "تأكيد",
    "ml.confirm.cancel": "تراجع",
    "ml.done.archive": "أُرشف الملف.",
    "ml.done.restore": "استُعيد الملف.",
    "ml.done.purge": "حُذف الملف نهائيًا.",
    "ml.done.purge_pending": "طُلب الحذف النهائي؛ سيكتمل حذف الملف تلقائيًا.",
  },
  en: {
    "ml.title": "Media Library",
    "ml.lead":
      "Platform images and videos for the Homepage, Trending, the Ads page and Collections. Kept apart from store uploads; their real content is checked on upload.",
    "ml.forbidden": "This page is for platform administrators only.",
    "ml.account": "My account",
    "ml.upload": "Upload a file",
    "ml.upload_lead":
      "JPEG, PNG and WebP images up to 10 MiB and 40 megapixels. MP4 (H.264, optional AAC) or WebM (VP8/VP9, optional Opus) video up to 100 MiB, 120 seconds and 1920×1080 or its portrait equivalent.",
    "ml.file": "File",
    "ml.name": "Name (optional)",
    "ml.category": "Category",
    "ml.uploading": "Uploading and checking…",
    "ml.uploaded": "The file was uploaded and checked.",
    "ml.search": "Search by name",
    "ml.f.category": "Category",
    "ml.f.kind": "Type",
    "ml.f.status": "Status",
    "ml.f.all": "All",
    "ml.apply": "Apply",
    "ml.cat.HOMEPAGE": "Homepage",
    "ml.cat.TRENDING": "Trending",
    "ml.cat.ADS": "Ads page",
    "ml.cat.COLLECTIONS": "Collections",
    "ml.kind.IMAGE": "Image",
    "ml.kind.VIDEO": "Video",
    "ml.status.ACTIVE": "Active",
    "ml.status.ARCHIVED": "Archived",
    "ml.status.ALL": "All",
    "ml.status.PURGING": "Being purged",
    "ml.empty": "No files match this search.",
    "ml.load_failed": "Could not load.",
    "ml.retry": "Retry",
    "ml.load_more": "Load more",
    "ml.open": "Open",
    "ml.used": "Used in {n}",
    "ml.unused": "Unused",
    "ml.back": "← Media Library",
    "ml.not_found": "File not found.",
    "ml.d.details": "Details",
    "ml.d.type": "Type",
    "ml.d.size": "Size",
    "ml.d.dimensions": "Dimensions",
    "ml.d.duration": "Duration",
    "ml.d.codecs": "Codecs",
    "ml.d.uploaded": "Uploaded",
    "ml.d.uploader": "Uploaded by",
    "ml.d.validation": "Validation",
    "ml.d.valid": "Valid",
    "ml.d.sha": "SHA-256",
    "ml.d.public_url": "Public immutable URL",
    "ml.d.no_public":
      "No public URL: the file is not published in any content.",
    "ml.d.usage": "Where it is used",
    "ml.d.usage_lead":
      "Any use (draft, scheduled, published or a restorable revision) blocks archiving and purging. The Content Studio (Phase 6) will record these uses.",
    "ml.d.no_usage": "Not used in any content.",
    "ml.usage.DRAFT": "Draft",
    "ml.usage.SCHEDULED": "Scheduled",
    "ml.usage.PUBLISHED": "Published",
    "ml.usage.REVISION": "Earlier revision",
    "ml.d.actions": "Actions",
    "ml.archive": "Archive",
    "ml.restore": "Restore",
    "ml.purge": "Purge permanently",
    "ml.archive_blocked": "Cannot archive: the file is in use.",
    "ml.purge_when": "Can be purged 30 days after archiving: {at}.",
    "ml.purge_blocked": "Permanent purge is not available now.",
    "ml.confirm.archive.title": "Confirm archiving",
    "ml.confirm.archive.lead":
      "The file leaves the pickers and can be restored later.",
    "ml.confirm.restore.title": "Confirm restoring",
    "ml.confirm.restore.lead": "The file becomes active again.",
    "ml.confirm.purge.title": "Confirm permanent purge",
    "ml.confirm.purge.lead":
      "The file and its record are deleted for good. This cannot be undone.",
    "ml.confirm.ok": "Confirm",
    "ml.confirm.cancel": "Go back",
    "ml.done.archive": "The file was archived.",
    "ml.done.restore": "The file was restored.",
    "ml.done.purge": "The file was purged.",
    "ml.done.purge_pending":
      "Purge requested; the file deletion will finish automatically.",
  },
});

export { fill } from "./offerModerationText";

export const MEDIA_CATEGORIES = [
  "HOMEPAGE",
  "TRENDING",
  "ADS",
  "COLLECTIONS",
] as const;

export function mediaUrl(apiRelative: string | null): string | null {
  if (!apiRelative) return null;
  const base =
    process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3001/api/v1";
  return `${base}${apiRelative}`;
}

export function bytes(n: number | null, lang: string): string {
  if (n === null) return "-";
  const locale = lang === "ar" ? "ar" : "en-GB";
  if (n < 1024 * 1024)
    return `${(n / 1024).toLocaleString(locale, { maximumFractionDigits: 1 })} KiB`;
  return `${(n / 1024 / 1024).toLocaleString(locale, { maximumFractionDigits: 1 })} MiB`;
}
