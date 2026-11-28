import {
  CANONICAL_PRODUCT_STATUS_LABEL,
  KIND_LABEL,
  PRODUCT_TYPE_LABEL,
  STORE_TYPE_LABEL,
  SUSPENSION_REASON_LABEL,
  VENDOR_STATUS_LABEL,
  VERIFICATION_STATUS_LABEL,
  adminErrorMessage,
  formatDateTime,
  reasonProblem,
} from "./admin";
import { ApiError } from "./api";
import type { Lang } from "./i18n";

// M-01 (Phase 2 Marketplace): shared bilingual helpers for the Marketplace
// admin pages. Arabic always comes unchanged from lib/admin.ts (labels,
// adminErrorMessage, reasonProblem, formatDateTime) so the Arabic UI is
// byte-for-byte what it was; English is added alongside.

/** "{name}" placeholders filled from values. */
export function fillMp(text: string, values: Record<string, string | number>): string {
  return text.replace(/\{(\w+)\}/g, (_, k: string) => String(values[k] ?? ""));
}

const LABELS = {
  storeType: { ar: STORE_TYPE_LABEL, en: { PHYSICAL: "Physical", ONLINE_ONLY: "Online only", HYBRID: "Hybrid" } },
  storeStatus: {
    ar: VENDOR_STATUS_LABEL,
    en: {
      APPLIED: "Applied",
      UNDER_REVIEW: "Under review",
      APPROVED: "Approved",
      REJECTED: "Rejected",
      ACTIVE: "Active",
      SUSPENDED: "Suspended",
      CANCELLED: "Cancelled",
    },
  },
  suspensionReason: {
    ar: SUSPENSION_REASON_LABEL,
    en: { POLICY_VIOLATION: "Policy violation", NON_PAYMENT: "Non-payment", OTHER: "Other reason" },
  },
  evidenceKind: { ar: KIND_LABEL, en: { BRANCH: "Branch evidence", WAREHOUSE: "Warehouse evidence" } },
  verificationStatus: {
    ar: VERIFICATION_STATUS_LABEL,
    en: {
      PENDING: "Pending review",
      APPROVED: "Approved",
      REJECTED: "Rejected",
      RESUBMISSION_REQUESTED: "Resubmission requested",
    },
  },
  canonicalStatus: {
    ar: CANONICAL_PRODUCT_STATUS_LABEL,
    en: { DRAFT: "Draft", PENDING_REVIEW: "Pending review", PUBLISHED: "Published", ARCHIVED: "Archived", MERGED: "Merged" },
  },
  productType: { ar: PRODUCT_TYPE_LABEL, en: { PHYSICAL: "Physical", BUNDLE: "Bundle", SERVICE: "Service" } },
} satisfies Record<string, { ar: Record<string, string>; en: Record<string, string> }>;

export type MpLabelKind = keyof typeof LABELS;

/** A status/type label in the UI language; unknown values show as-is. */
export function mpLabel(lang: Lang, kind: MpLabelKind, value: string): string {
  const map: Record<string, string> = LABELS[kind][lang] ?? LABELS[kind].ar;
  return map[value] ?? value;
}

/** Every value of a label set, in the UI language (for <select> options). */
export function mpLabelEntries(lang: Lang, kind: MpLabelKind): [string, string][] {
  return Object.keys(LABELS[kind].ar).map((k) => [k, mpLabel(lang, kind, k)]);
}

const EN_ERRORS: Record<string, string> = {
  BRANCH_EVIDENCE_STALE: "The evidence changed after you read it. Reload the page and decide on the current version.",
  WAREHOUSE_EVIDENCE_STALE: "This is no longer the current pending evidence. Reload the page.",
  NO_PENDING_BRANCH_EVIDENCE: "There is no pending evidence for this branch now.",
  NO_PENDING_WAREHOUSE_EVIDENCE: "There is no pending evidence for this warehouse now.",
  PLATFORM_VENDOR_CONFLICT_OF_INTEREST: "You are a member of this store, so you cannot decide on it.",
  VENDOR_NOT_UNDER_REVIEW: "This store is no longer under review.",
  BRANCH_NOT_PENDING: "This branch has already been decided.",
  VENDOR_ALREADY_SUSPENDED: "This store is already suspended.",
  VENDOR_NOT_ACTIVE: "Only an active store can be suspended.",
  VENDOR_NOT_SUSPENDED: "This store is not suspended.",
  FORBIDDEN: "You do not have permission for this action.",
  CATEGORY_NOT_FOUND: "The category was not found.",
  PARENT_CATEGORY_NOT_FOUND: "The parent category was not found.",
  CATEGORY_CYCLE: "This parent category cannot be chosen (it would create a loop in the category tree).",
  CATEGORY_HAS_CHILDREN: "A category that has subcategories cannot be deleted.",
  CATEGORY_IN_USE: "This category cannot be deleted because canonical products belong to it.",
  BRAND_NOT_FOUND: "The brand was not found.",
  BRAND_ALREADY_EXISTS: "A brand with this name already exists.",
  BRAND_SENTINEL_IMMUTABLE: "This brand cannot be deleted (a core system record).",
  BRAND_IN_USE: "This brand cannot be deleted because products are linked to it.",
  CANONICAL_PRODUCT_NOT_FOUND: "The canonical product was not found.",
  CATEGORY_RESTRICTED: "This category is restricted; a canonical product cannot be created under it.",
  VARIANT_IDENTIFIER_ALREADY_EXISTS: "Another variant has the same identifier (MPN/GTIN).",
  DUPLICATE_VARIANT: "A variant with these attributes already exists.",
  INVALID_STATUS_TRANSITION: "This status cannot be reached from the product's current status.",
  MERGE_VARIANT_UNMATCHED: "Merge failed: some variants of this product have no matching variant in the surviving product.",
  SPLIT_WOULD_SPAN_VENDOR_OFFER: "Split failed: a store offer is linked to variants that would be split across two products.",
  SPLIT_REQUIRES_AT_LEAST_ONE_VARIANT: "Choose at least one variant to split.",
  SPLIT_CANNOT_MOVE_ALL_VARIANTS: "Not every variant can be moved; the original product must keep at least one.",
  FEATURE_DISABLED: "This feature is currently disabled.",
  INVALID_DATE: "Invalid date.",
};

/** An API failure as text in the UI language. Arabic is exactly adminErrorMessage. */
export function mpError(err: unknown, lang: Lang): string {
  if (lang === "ar") return adminErrorMessage(err);
  if (err instanceof ApiError) return EN_ERRORS[err.code] ?? err.message;
  return "Could not reach the server.";
}

/** The 10-1000 character reason rule, in the UI language. */
export function mpReasonProblem(raw: string, lang: Lang): string | null {
  const ar = reasonProblem(raw);
  if (ar === null || lang === "ar") return ar;
  return raw.trim().length < 10 ? "Write a reason of at least 10 characters" : "The reason is too long (1000 characters max)";
}

/** Date + time in the UI language (Arabic output unchanged). */
export function mpDate(iso: string | null, lang: Lang): string {
  return formatDateTime(iso, lang === "en" ? "en" : "ar");
}

/** The fetch-hook error string in the UI language: Arabic keeps the hook's own text. */
export function mpFetchError(error: string | null, apiError: unknown, lang: Lang): string | null {
  if (!error) return null;
  return lang === "ar" ? error : mpError(apiError ?? null, lang);
}
