import { registerTranslations } from "./i18n";

// Dashboard "recent admin activity": readable names for the audit actions
// platform staff record (auth, workspace, platform-admin, verification,
// moderation, catalog, Content Studio, Media Library, ...) and for the
// entity types they touch. Display only - the Audit Log keeps the raw
// codes, and an action without a name here still shows its raw code.

const ACTIONS: Record<string, [ar: string, en: string]> = {
  // Sign-in and workspace
  "user.login": ["تسجيل دخول", "Signed in"],
  "user.logout": ["تسجيل خروج", "Signed out"],
  "user.password_reset": ["إعادة تعيين كلمة المرور", "Password reset"],
  "user.registered": ["تسجيل حساب جديد", "Account registered"],
  "user.reactivated": ["إعادة تفعيل الحساب", "Account reactivated"],
  "user.suspended_by_platform": ["إيقاف حساب من المنصة", "Account suspended by the platform"],
  "user.suspension_lifted": ["رفع إيقاف الحساب", "Account suspension lifted"],
  "user.sessions_revoked_by_platform": ["إخراج الحساب من كل الأجهزة", "Signed out of all devices by the platform"],
  "workspace.entered": ["الدخول إلى مساحة العمل", "Entered the workspace"],
  // Stores and verification
  "vendor.applied": ["طلب انضمام متجر", "Store applied"],
  "vendor.under_review": ["متجر قيد المراجعة", "Store put under review"],
  "vendor.approved": ["اعتماد متجر", "Store approved"],
  "vendor.rejected": ["رفض متجر", "Store rejected"],
  "vendor.activated": ["تفعيل متجر", "Store activated"],
  "vendor.suspended": ["تعليق متجر", "Store suspended"],
  "vendor.reactivated": ["إعادة تفعيل متجر", "Store reactivated"],
  "vendor.storefront_published": ["نشر واجهة متجر", "Storefront published"],
  "vendor.storefront_unpublished": ["إلغاء نشر واجهة متجر", "Storefront unpublished"],
  "vendor.storefront_updated": ["تعديل واجهة متجر", "Storefront updated"],
  "vendor.storefront_catalogue_updated": ["تعديل كتالوج واجهة متجر", "Storefront catalogue updated"],
  "store_branch.evidence_submitted": ["إرسال أدلة تحقق فرع", "Branch evidence submitted"],
  "store_branch.verification_decided": ["قرار تحقق فرع", "Branch verification decided"],
  "branch_verification_evidence.viewed": ["عرض أدلة تحقق فرع", "Branch evidence viewed"],
  "warehouse_verification_evidence.submitted": ["إرسال أدلة تحقق مستودع", "Warehouse evidence submitted"],
  "warehouse_verification_evidence.decided": ["قرار تحقق مستودع", "Warehouse verification decided"],
  "warehouse_verification_evidence.viewed": ["عرض أدلة تحقق مستودع", "Warehouse evidence viewed"],
  "vendor_user.staff_invite_accepted": ["قبول دعوة موظف", "Staff invite accepted"],
  // Offer moderation
  "offer.platform_hold_placed": ["إخفاء عرض من المنصة", "Offer placed on platform hold"],
  "offer.platform_hold_released": ["رفع إخفاء عرض", "Offer platform hold released"],
  "offer.platform_hold_correction_submitted": ["إرسال تعديل عرض للمراجعة", "Offer correction submitted"],
  "offer.platform_hold_correction_returned": ["إعادة تعديل عرض للمتجر", "Offer correction returned"],
  "offer.measurements_saved": ["حفظ قياسات عرض", "Offer measurements saved"],
  "offer.measurements_removed": ["حذف قياسات عرض", "Offer measurements removed"],
  "offer.size_guide_chosen": ["اختيار دليل مقاسات لعرض", "Offer size guide chosen"],
  "offer_variant.match_proposed": ["اقتراح تطابق متغيّر", "Variant match proposed"],
  "vendor_offer.classification_changed": ["تغيير تصنيف عرض", "Offer classification changed"],
  "vendor_offer.combinations_created": ["إنشاء تركيبات عرض", "Offer combinations created"],
  "vendor_offer.title_adopted_canonical_name": ["اعتماد الاسم المرجعي لعرض", "Offer title adopted canonical name"],
  "checkout.reservation_released_platform_hold": ["تحرير حجز بسبب إخفاء عرض", "Reservation released by a platform hold"],
  "match_review_candidate.created_from_exact_report": ["إنشاء مرشّح تطابق من بلاغ", "Match candidate created from a report"],
  "match_review_candidate.requeued_from_report": ["إعادة مرشّح تطابق للمراجعة", "Match candidate requeued from a report"],
  // Catalog
  "canonical_product.created": ["إنشاء منتج مرجعي", "Canonical product created"],
  "canonical_product.updated": ["تعديل منتج مرجعي", "Canonical product updated"],
  "canonical_product.merged": ["دمج منتجات مرجعية", "Canonical products merged"],
  "canonical_product.split": ["تقسيم منتج مرجعي", "Canonical product split"],
  "canonical_product.restricted": ["تقييد منتج مرجعي", "Canonical product restricted"],
  "canonical_product.unrestricted": ["رفع تقييد منتج مرجعي", "Canonical product unrestricted"],
  "canonical_product.status_transition": ["تغيير حالة منتج مرجعي", "Canonical product status changed"],
  "canonical_product.status_transition_rejected": ["رفض تغيير حالة منتج مرجعي", "Canonical product status change refused"],
  "canonical_product.name_change_approved": ["اعتماد تغيير اسم منتج", "Product name change approved"],
  "canonical_product.name_set_provisional": ["تعيين اسم مؤقت لمنتج", "Provisional product name set"],
  "canonical_product_variant.created": ["إنشاء متغيّر منتج مرجعي", "Canonical variant created"],
  "canonical_name_change_request.created": ["طلب تغيير اسم منتج", "Name change requested"],
  "category.created": ["إنشاء تصنيف", "Category created"],
  "category.updated": ["تعديل تصنيف", "Category updated"],
  "category.deleted": ["حذف تصنيف", "Category deleted"],
  "category.restricted": ["تقييد تصنيف", "Category restricted"],
  "category.unrestricted": ["رفع تقييد تصنيف", "Category unrestricted"],
  "brand.created": ["إضافة علامة تجارية", "Brand created"],
  "brand.updated": ["تعديل علامة تجارية", "Brand updated"],
  "brand.deleted": ["حذف علامة تجارية", "Brand deleted"],
  "brand_request.approved": ["اعتماد طلب علامة تجارية", "Brand request approved"],
  "brand_request.rejected": ["رفض طلب علامة تجارية", "Brand request rejected"],
  "size_guide.created": ["إنشاء دليل مقاسات", "Size guide created"],
  "size_guide.draft_saved": ["حفظ مسودة دليل مقاسات", "Size guide draft saved"],
  "size_guide.published": ["نشر دليل مقاسات", "Size guide published"],
  "size_guide.renamed": ["إعادة تسمية دليل مقاسات", "Size guide renamed"],
  "size_guide.retired": ["إيقاف دليل مقاسات", "Size guide retired"],
  "size_guide.version_created": ["إصدار جديد لدليل مقاسات", "Size guide version created"],
  "size_guide.applicability_set": ["ربط دليل مقاسات بالتصنيفات", "Size guide applicability set"],
  "size_guide_request.created": ["طلب دليل مقاسات", "Size guide requested"],
  "size_guide_request.decided": ["قرار طلب دليل مقاسات", "Size guide request decided"],
  "platform_collection.created": ["إنشاء مجموعة منصة", "Platform collection created"],
  "platform_collection.updated": ["تعديل مجموعة منصة", "Platform collection updated"],
  "platform_collection.deleted": ["حذف مجموعة منصة", "Platform collection deleted"],
  "platform_collection.reordered": ["إعادة ترتيب مجموعات المنصة", "Platform collections reordered"],
  // Orders, returns, reviews
  "branch_order.status_changed": ["تغيير حالة طلب", "Order status changed"],
  "branch_order_item.cancelled": ["إلغاء بند طلب", "Order line cancelled"],
  "branch_order.integrity_flagged": ["رصد خلل في طلب", "Order integrity flagged"],
  "branch_order.integrity_repaired": ["إصلاح خلل في طلب", "Order integrity repaired"],
  "branch_order.internal_note_updated": ["تعديل ملاحظة داخلية على طلب", "Order internal note updated"],
  "branch_order.address_changed": ["تغيير عنوان طلب", "Order address changed"],
  "branch_order.converted_to_pickup": ["تحويل طلب إلى استلام", "Order converted to pickup"],
  "return.refund_processed": ["تنفيذ استرداد إرجاع", "Return refund processed"],
  "return.received": ["استلام مرتجع", "Return received"],
  "return.auto_escalated": ["تصعيد إرجاع تلقائيًا", "Return auto-escalated"],
  "return.disputed": ["اعتراض على إرجاع", "Return disputed"],
  "review.media_hidden": ["إخفاء وسائط مراجعة", "Review media hidden"],
  "review.deleted": ["حذف مراجعة", "Review deleted"],
  "review.reported": ["الإبلاغ عن مراجعة", "Review reported"],
  // Content Studio and Media Library
  "content.imported": ["استيراد محتوى صفحة", "Page content imported"],
  "content.draft_saved": ["حفظ مسودة صفحة", "Page draft saved"],
  "content.published": ["نشر صفحة", "Page published"],
  "content.unpublished": ["إلغاء نشر صفحة", "Page unpublished"],
  "content.scheduled": ["جدولة نشر صفحة", "Page publication scheduled"],
  "content.schedule_replaced": ["استبدال جدولة نشر صفحة", "Page schedule replaced"],
  "content.schedule_cancelled": ["إلغاء جدولة نشر صفحة", "Page schedule cancelled"],
  "content.schedule_published": ["نشر صفحة مجدولة", "Scheduled page published"],
  "content.schedule_failed": ["فشل نشر صفحة مجدولة", "Scheduled publication failed"],
  "content.restored": ["استعادة نسخة صفحة", "Page version restored"],
  "content.revision_loaded_into_draft": ["تحميل نسخة سابقة في المسودة", "Revision loaded into the draft"],
  "content.revision_archived": ["أرشفة نسخة صفحة", "Page revision archived"],
  "media.uploaded": ["رفع وسائط", "Media uploaded"],
  "media.archived": ["أرشفة وسائط", "Media archived"],
  "media.restored": ["استعادة وسائط", "Media restored"],
  "media.purge_requested": ["طلب حذف وسائط نهائيًا", "Media purge requested"],
  "media.purged": ["حذف وسائط نهائيًا", "Media purged"],
  // Platform settings
  "feature_flag.changed": ["تغيير علم ميزة", "Feature flag changed"],
  "platform_alert_recipient.added": ["إضافة مستلم تنبيهات", "Alert recipient added"],
  "outbox.reconciled": ["مطابقة صندوق الإرسال", "Outbox reconciled"],
  "sales_rank.recomputed": ["إعادة حساب ترتيب المبيعات", "Sales rank recomputed"],
};

const ENTITIES: Record<string, [ar: string, en: string]> = {
  Platform: ["المنصة", "Platform"],
  User: ["مستخدم", "User"],
  Vendor: ["متجر", "Store"],
  VendorUser: ["عضو متجر", "Store member"],
  StaffInvite: ["دعوة موظف", "Staff invite"],
  StoreBranch: ["فرع", "Branch"],
  Warehouse: ["مستودع", "Warehouse"],
  WarehouseVerificationEvidence: ["أدلة تحقق مستودع", "Warehouse evidence"],
  VendorOffer: ["عرض", "Offer"],
  OfferVariant: ["متغيّر عرض", "Offer variant"],
  CanonicalProduct: ["منتج مرجعي", "Canonical product"],
  CanonicalProductVariant: ["متغيّر منتج مرجعي", "Canonical variant"],
  CanonicalNameChangeRequest: ["طلب تغيير اسم", "Name change request"],
  MatchReviewCandidate: ["مرشّح تطابق", "Match candidate"],
  Category: ["تصنيف", "Category"],
  Brand: ["علامة تجارية", "Brand"],
  BrandRequest: ["طلب علامة تجارية", "Brand request"],
  SizeGuide: ["دليل مقاسات", "Size guide"],
  SizeGuideRequest: ["طلب دليل مقاسات", "Size guide request"],
  PlatformCollection: ["مجموعة منصة", "Platform collection"],
  BranchOrder: ["طلب فرع", "Branch order"],
  CheckoutReservation: ["حجز", "Reservation"],
  Return: ["إرجاع", "Return"],
  Review: ["مراجعة", "Review"],
  ReviewReport: ["بلاغ مراجعة", "Review report"],
  ContentPage: ["صفحة محتوى", "Content page"],
  MediaAsset: ["ملف وسائط", "Media asset"],
  FeatureFlag: ["علم ميزة", "Feature flag"],
  OutboxEvent: ["حدث صندوق الإرسال", "Outbox event"],
  SalesRankRun: ["حساب ترتيب المبيعات", "Sales rank run"],
};

const ar: Record<string, string> = {};
const en: Record<string, string> = {};
for (const [code, [a, e]] of Object.entries(ACTIONS)) {
  ar[`audit.action.${code}`] = a;
  en[`audit.action.${code}`] = e;
}
for (const [type, [a, e]] of Object.entries(ENTITIES)) {
  ar[`audit.entity.${type}`] = a;
  en[`audit.entity.${type}`] = e;
}
registerTranslations({ ar, en });

/** The readable name, or null when this code has none (show the raw code). */
export function auditText(
  t: (key: string) => string,
  kind: "action" | "entity",
  code: string,
): string | null {
  const key = `audit.${kind}.${code}`;
  const text = t(key);
  return text === key ? null : text;
}
