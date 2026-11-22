// PD-5b.3: the admin's platform collections - API shapes (PD-5b.1),
// labels and Arabic error messages. Every rule lives on the server; this
// file only names and words what the API returns.
import { ApiError } from "./api";
import { adminErrorMessage } from "./admin";

export type CollectionStatus = "DRAFT" | "PUBLISHED" | "ARCHIVED";

export interface AdminCollection {
  id: string;
  slug: string;
  title_ar: string;
  title_en: string;
  description_ar: string | null;
  description_en: string | null;
  audience: "WOMEN" | "MEN" | "KIDS" | null;
  show_on_home: boolean;
  status: CollectionStatus;
  publish_from: string | null;
  publish_until: string | null;
  /** PUBLISHED and inside the window, right now. */
  live: boolean;
  sort_order: number;
  ever_published: boolean;
  published_at: string | null;
  archived_at: string | null;
  updated_at: string;
  item_count?: number;
}

export interface AdminCollectionItem {
  canonical_product_id: string;
  name: string;
  product_status: string;
  note: "MERGED" | "ARCHIVED" | "NOT_PUBLISHED" | null;
  merged_into_id: string | null;
  sort_order: number;
}

export interface AdminCollectionDetail extends AdminCollection {
  items: AdminCollectionItem[];
}

export const MAX_COLLECTION_ITEMS = 24;

export const STATUS_LABEL: Record<CollectionStatus, string> = {
  DRAFT: "مسودة",
  PUBLISHED: "منشورة",
  ARCHIVED: "مؤرشفة",
};

export const AUDIENCE_LABEL: Record<string, string> = { WOMEN: "نساء", MEN: "رجال", KIDS: "أطفال" };

export const NOTE_LABEL: Record<NonNullable<AdminCollectionItem["note"]>, string> = {
  MERGED: "مدموج في منتج آخر - يُعرض بدلاً منه المنتج الباقي",
  ARCHIVED: "مؤرشف - لن يظهر للعملاء",
  NOT_PUBLISHED: "غير منشور - لن يظهر للعملاء",
};

/** "live now" / "scheduled" / "ended" for a PUBLISHED collection; null otherwise. */
export function liveLabel(c: AdminCollection, now = new Date()): string | null {
  if (c.status !== "PUBLISHED") return null;
  if (c.live) return "ظاهرة الآن";
  if (c.publish_from && new Date(c.publish_from) > now) return "مجدولة - لم تبدأ بعد";
  return "انتهت فترة نشرها";
}

const ERRORS: Record<string, string> = {
  COLLECTION_SLUG_TAKEN: "هذا الرابط مستخدم لمجموعة أخرى",
  COLLECTION_SLUG_LOCKED: "لا يتغيّر رابط مجموعة سبق نشرها",
  INVALID_PUBLISH_WINDOW: "نهاية فترة النشر يجب أن تكون بعد بدايتها",
  COLLECTION_ARCHIVED: "المجموعة مؤرشفة - أعيدي فتحها كمسودة قبل التعديل",
  INVALID_COLLECTION_TRANSITION: "لا يمكن هذا الانتقال من حالة المجموعة الحالية",
  COLLECTION_NEVER_PUBLISHED: "مسودة لم تُنشر قط تُحذف ولا تُؤرشف",
  COLLECTION_NOT_DELETABLE: "مجموعة سبق نشرها تُؤرشف ولا تُحذف",
  COLLECTION_ORDER_MISMATCH: "تغيّرت قائمة المجموعات - أعيدي التحميل ثم رتّبي من جديد",
  CANONICAL_PRODUCT_NOT_FOUND: "أحد المنتجات لم يعد موجوداً",
  CANONICAL_PRODUCT_ARCHIVED: "لا يمكن إضافة منتج مؤرشف",
  CANONICAL_PRODUCT_MERGED: "هذا المنتج مدموج في منتج آخر - أضيفي المنتج الباقي بدلاً منه",
  COLLECTION_NOT_FOUND: "المجموعة غير موجودة",
};

/** An admin collections call's failure, in Arabic. */
export function collectionError(err: unknown): string {
  if (err instanceof ApiError) return ERRORS[err.code] ?? adminErrorMessage(err);
  return adminErrorMessage(err);
}

/** "2026-11-01T10:00" (local) <-> ISO, for <input type="datetime-local">. */
export function toLocalInput(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function fromLocalInput(value: string): string | null {
  return value ? new Date(value).toISOString() : null;
}

export function formatWindow(c: Pick<AdminCollection, "publish_from" | "publish_until">): string {
  const f = (iso: string) => new Date(iso).toLocaleString("ar-EG", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
  if (!c.publish_from && !c.publish_until) return "بلا نافذة (دائمة عند النشر)";
  return `${c.publish_from ? `من ${f(c.publish_from)}` : "من الآن"} ${c.publish_until ? `حتى ${f(c.publish_until)}` : "بلا نهاية"}`;
}
