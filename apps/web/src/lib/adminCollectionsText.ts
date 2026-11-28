import { ApiError } from "./api";
import { registerTranslations, type Lang } from "./i18n";
import { mpError } from "./adminMarketplaceText";
import {
  AUDIENCE_LABEL,
  NOTE_LABEL,
  STATUS_LABEL,
  collectionError,
  formatWindow,
  liveLabel,
  type AdminCollection,
  type AdminCollectionItem,
  type CollectionStatus,
} from "./platformCollections";

// M-01: /admin/collections and /admin/collections/[id]. Arabic comes
// unchanged from the pages and lib/platformCollections.ts; English is added.

registerTranslations({
  ar: {
    "mpa.col.forbidden": "هذه الصفحة لمدير المنصة فقط",
    "mpa.col.myAccount": "حسابي",
    "mpa.col.dashboard": "إدارة المنصة",
    "mpa.col.title": "مجموعات المنصة",
    "mpa.col.lead": "مجموعات تحريرية من المنتجات الموحّدة. تظهر للعملاء المجموعة المنشورة ضمن نافذة نشرها فقط، ويظهر منها فقط ما يمكن شراؤه لحظة العرض وفق منطقة العميل.",
    "mpa.col.confirmDelete": "حذف هذه المسودة نهائياً؟",
    "mpa.col.orderSaved": "تم حفظ ترتيب المجموعات",
    "mpa.col.newDraft": "مسودة جديدة",
    "mpa.col.slugHint": "الرابط (حروف إنجليزية صغيرة وأرقام وشرطات)",
    "mpa.col.titleAr": "العنوان بالعربية",
    "mpa.col.titleEn": "العنوان بالإنجليزية",
    "mpa.col.createDraft": "إنشاء مسودة",
    "mpa.col.collections": "المجموعات",
    "mpa.col.saveOrder": "حفظ الترتيب",
    "mpa.col.retry": "إعادة المحاولة",
    "mpa.col.empty": "لا توجد مجموعات بعد.",
    "mpa.col.noAudience": "بلا قسم",
    "mpa.col.onHome": "في الرئيسية",
    "mpa.col.notOnHome": "ليست في الرئيسية",
    "mpa.col.itemCount": "{n} / 24 منتجاً",
    "mpa.col.moveUp": "تقديم {name}",
    "mpa.col.moveDown": "تأخير {name}",
    "mpa.col.openEdit": "فتح/تعديل",
    "mpa.col.publish": "نشر",
    "mpa.col.published": "تم النشر",
    "mpa.col.archive": "أرشفة",
    "mpa.col.archived": "تمت الأرشفة",
    "mpa.col.reopen": "إعادة فتح كمسودة",
    "mpa.col.reopened": "أعيد فتحها كمسودة",
    "mpa.col.delete": "حذف",
    "mpa.col.deleted": "تم حذف المسودة",
    "mpa.col.mergedHint": "هذا المنتج مدموج في «{name}» - أضيفي «{name}» بدلاً منه.",
    "mpa.col.fieldsSaved": "تم حفظ البيانات",
    "mpa.col.itemsSaved": "تم حفظ المنتجات",
    "mpa.col.notFound": "المجموعة غير موجودة",
    "mpa.col.loadFailed": "تعذّر تحميل المجموعة",
    "mpa.col.statusTitle": "الحالة",
    "mpa.col.saveItemsFirst": "احفظي المنتجات أولاً",
    "mpa.col.deleteDraft": "حذف المسودة",
    "mpa.col.archivedHint": "المجموعة مؤرشفة: أعيدي فتحها كمسودة لتعديلها.",
    "mpa.col.publishedHint": "لا تُعدَّل الحالة إلى مسودة من النشر مباشرة؛ أرشفيها ثم أعيدي فتحها.",
    "mpa.col.dataTitle": "البيانات",
    "mpa.col.slug": "الرابط",
    "mpa.col.slugLocked": "لا يتغيّر رابط مجموعة سبق نشرها.",
    "mpa.col.descAr": "الوصف بالعربية (اختياري)",
    "mpa.col.descEn": "الوصف بالإنجليزية (اختياري)",
    "mpa.col.audience": "القسم",
    "mpa.col.showOnHome": "تظهر في الرئيسية",
    "mpa.col.from": "بداية النشر (اختياري)",
    "mpa.col.until": "نهاية النشر (اختياري)",
    "mpa.col.saveFields": "حفظ البيانات",
    "mpa.col.products": "المنتجات ({n} / {max})",
    "mpa.col.unsaved": "تغييرات غير محفوظة",
    "mpa.col.availabilityNote": "يُفحص توفر كل منتج ومنطقة العميل لحظة عرض المجموعة: يظهر للعميل فقط ما يمكن شراؤه آنذاك، لذا قد لا يظهر كل منتج هنا دائماً. لا تظهر المجموعة في الرئيسية أو الأقسام إلا بأربعة منتجات متاحة على الأقل.",
    "mpa.col.noProducts": "لا توجد منتجات بعد.",
    "mpa.col.productFallback": "منتج",
    "mpa.col.hiddenNow": "غير متاح للشراء الآن - لا يظهر للعملاء حالياً",
    "mpa.col.newUnsaved": "جديد - لم يُحفظ بعد",
    "mpa.col.remove": "إزالة",
    "mpa.col.addProduct": "إضافة منتج (ابحثي بالاسم)",
    "mpa.col.minChars": "حرفان على الأقل",
    "mpa.col.maxReached": "وصلتِ للحد الأقصى ({max}).",
    "mpa.col.searchResults": "نتائج البحث",
    "mpa.col.statusMerged": "مدموج",
    "mpa.col.statusArchived": "مؤرشف",
    "mpa.col.statusUnpublished": "غير منشور",
    "mpa.col.add": "إضافة",
    "mpa.col.saveItems": "حفظ المنتجات",
  },
  en: {
    "mpa.col.forbidden": "This page is for platform administrators only",
    "mpa.col.myAccount": "My account",
    "mpa.col.dashboard": "Platform management",
    "mpa.col.title": "Platform collections",
    "mpa.col.lead": "Editorial collections of canonical products. Customers see a published collection only within its publishing window, and only the products that can be bought at that moment in their delivery zone.",
    "mpa.col.confirmDelete": "Delete this draft permanently?",
    "mpa.col.orderSaved": "The collection order was saved",
    "mpa.col.newDraft": "New draft",
    "mpa.col.slugHint": "Link (lowercase English letters, digits and dashes)",
    "mpa.col.titleAr": "Arabic title",
    "mpa.col.titleEn": "English title",
    "mpa.col.createDraft": "Create draft",
    "mpa.col.collections": "Collections",
    "mpa.col.saveOrder": "Save order",
    "mpa.col.retry": "Retry",
    "mpa.col.empty": "No collections yet.",
    "mpa.col.noAudience": "No section",
    "mpa.col.onHome": "On the homepage",
    "mpa.col.notOnHome": "Not on the homepage",
    "mpa.col.itemCount": "{n} / 24 products",
    "mpa.col.moveUp": "Move {name} up",
    "mpa.col.moveDown": "Move {name} down",
    "mpa.col.openEdit": "Open/edit",
    "mpa.col.publish": "Publish",
    "mpa.col.published": "Published",
    "mpa.col.archive": "Archive",
    "mpa.col.archived": "Archived",
    "mpa.col.reopen": "Reopen as draft",
    "mpa.col.reopened": "Reopened as a draft",
    "mpa.col.delete": "Delete",
    "mpa.col.deleted": "The draft was deleted",
    "mpa.col.mergedHint": "This product was merged into «{name}» - add «{name}» instead.",
    "mpa.col.fieldsSaved": "Details saved",
    "mpa.col.itemsSaved": "Products saved",
    "mpa.col.notFound": "Collection not found",
    "mpa.col.loadFailed": "Could not load the collection",
    "mpa.col.statusTitle": "Status",
    "mpa.col.saveItemsFirst": "Save the products first",
    "mpa.col.deleteDraft": "Delete draft",
    "mpa.col.archivedHint": "The collection is archived: reopen it as a draft to edit it.",
    "mpa.col.publishedHint": "A published collection cannot go straight back to draft; archive it, then reopen it.",
    "mpa.col.dataTitle": "Details",
    "mpa.col.slug": "Link",
    "mpa.col.slugLocked": "The link of a collection that was published cannot change.",
    "mpa.col.descAr": "Arabic description (optional)",
    "mpa.col.descEn": "English description (optional)",
    "mpa.col.audience": "Section",
    "mpa.col.showOnHome": "Show on the homepage",
    "mpa.col.from": "Publish from (optional)",
    "mpa.col.until": "Publish until (optional)",
    "mpa.col.saveFields": "Save details",
    "mpa.col.products": "Products ({n} / {max})",
    "mpa.col.unsaved": "Unsaved changes",
    "mpa.col.availabilityNote": "Each product's availability and the customer's zone are checked when the collection is shown: customers see only what can be bought at that moment, so not every product here always appears. A collection shows on the homepage or a section only with at least four available products.",
    "mpa.col.noProducts": "No products yet.",
    "mpa.col.productFallback": "Product",
    "mpa.col.hiddenNow": "Not purchasable now - not shown to customers at the moment",
    "mpa.col.newUnsaved": "New - not saved yet",
    "mpa.col.remove": "Remove",
    "mpa.col.addProduct": "Add a product (search by name)",
    "mpa.col.minChars": "At least two characters",
    "mpa.col.maxReached": "You reached the maximum ({max}).",
    "mpa.col.searchResults": "Search results",
    "mpa.col.statusMerged": "Merged",
    "mpa.col.statusArchived": "Archived",
    "mpa.col.statusUnpublished": "Not published",
    "mpa.col.add": "Add",
    "mpa.col.saveItems": "Save products",
  },
});

const EN_STATUS: Record<CollectionStatus, string> = { DRAFT: "Draft", PUBLISHED: "Published", ARCHIVED: "Archived" };
const EN_AUDIENCE: Record<string, string> = { WOMEN: "Women", MEN: "Men", KIDS: "Kids" };
const EN_NOTE: Record<NonNullable<AdminCollectionItem["note"]>, string> = {
  MERGED: "Merged into another product - the remaining product is shown instead",
  ARCHIVED: "Archived - not shown to customers",
  NOT_PUBLISHED: "Not published - not shown to customers",
};
const EN_ERRORS: Record<string, string> = {
  COLLECTION_SLUG_TAKEN: "This link is used by another collection",
  COLLECTION_SLUG_LOCKED: "The link of a collection that was published cannot change",
  INVALID_PUBLISH_WINDOW: "The publishing end must be after its start",
  COLLECTION_ARCHIVED: "The collection is archived - reopen it as a draft before editing",
  INVALID_COLLECTION_TRANSITION: "This change is not possible from the collection's current status",
  COLLECTION_NEVER_PUBLISHED: "A draft that was never published is deleted, not archived",
  COLLECTION_NOT_DELETABLE: "A collection that was published is archived, not deleted",
  COLLECTION_ORDER_MISMATCH: "The collection list changed - reload, then reorder",
  CANONICAL_PRODUCT_NOT_FOUND: "One of the products no longer exists",
  CANONICAL_PRODUCT_ARCHIVED: "An archived product cannot be added",
  CANONICAL_PRODUCT_MERGED: "This product was merged into another - add the remaining product instead",
  COLLECTION_NOT_FOUND: "Collection not found",
};

export const collStatus = (lang: Lang, s: CollectionStatus) => (lang === "en" ? EN_STATUS : STATUS_LABEL)[s];
export const collAudienceEntries = (lang: Lang) => Object.entries(lang === "en" ? EN_AUDIENCE : AUDIENCE_LABEL);
export const collAudience = (lang: Lang, a: string) => (lang === "en" ? EN_AUDIENCE : AUDIENCE_LABEL)[a] ?? a;
export const collNote = (lang: Lang, n: NonNullable<AdminCollectionItem["note"]>) => (lang === "en" ? EN_NOTE : NOTE_LABEL)[n];

/** Arabic is exactly liveLabel(). */
export function collLive(lang: Lang, c: AdminCollection, now = new Date()): string | null {
  if (lang === "ar") return liveLabel(c, now);
  if (c.status !== "PUBLISHED") return null;
  if (c.live) return "Live now";
  if (c.publish_from && new Date(c.publish_from) > now) return "Scheduled - not started yet";
  return "Its publishing window has ended";
}

/** Arabic is exactly collectionError(). */
export function collError(err: unknown, lang: Lang): string {
  if (lang === "ar") return collectionError(err);
  if (err instanceof ApiError && EN_ERRORS[err.code]) return EN_ERRORS[err.code];
  return mpError(err, lang);
}

/** Arabic is exactly formatWindow(). */
export function collWindow(c: Pick<AdminCollection, "publish_from" | "publish_until">, lang: Lang): string {
  if (lang === "ar") return formatWindow(c);
  const f = (iso: string) => new Date(iso).toLocaleString("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
  if (!c.publish_from && !c.publish_until) return "No window (always on when published)";
  return `${c.publish_from ? `from ${f(c.publish_from)}` : "from now"} ${c.publish_until ? `until ${f(c.publish_until)}` : "with no end"}`;
}
