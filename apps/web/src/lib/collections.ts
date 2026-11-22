import { apiFetch } from "./api";

/** «مجموعات المتجر»: one of the store's own collections, as the owner sees it. */
export interface StoreCollection {
  id: string;
  name_ar: string;
  name_en: string | null;
  cover_url: string | null;
  visible: boolean;
  sort_order: number;
  product_count: number;
  shopper_count: number;
  shown_to_shoppers: boolean;
  offer_ids: string[];
}

export interface CollectionItem {
  offer_id: string;
  title_ar: string;
  title_en: string;
  status: "DRAFT" | "ACTIVE" | "INACTIVE" | "ARCHIVED";
  audiences: string[];
  categories: string[];
  image_url: string | null;
  available: number;
  shown_to_shoppers: boolean;
  position: number;
}

export interface CollectionDetail extends Omit<StoreCollection, "offer_ids"> {
  limit: number;
  page: number;
  page_size: number;
  items: CollectionItem[];
}

export interface CandidateItem {
  offer_id: string;
  title_ar: string;
  title_en: string;
  status: CollectionItem["status"];
  audiences: string[];
  categories: string[];
  image_url: string | null;
  available: number;
  in_collection: boolean;
}

export interface CandidatesPage {
  total: number;
  page: number;
  page_size: number;
  categories: string[];
  in_collection: number;
  items: CandidateItem[];
}

export const MAX_COLLECTIONS = 20;
export const MAX_COLLECTION_PRODUCTS = 500;

const base = (vendorId: string) => `/vendors/${vendorId}/sections`;

export const collectionsApi = {
  list: (vendorId: string) => apiFetch<StoreCollection[]>(base(vendorId)),
  detail: (vendorId: string, id: string, page = 1, pageSize = 50) =>
    apiFetch<CollectionDetail>(`${base(vendorId)}/${id}?page=${page}&page_size=${pageSize}`),
  create: (vendorId: string, body: { name_ar: string; name_en: string | null; cover_url: string | null; visible: boolean }) =>
    apiFetch<{ id: string }>(base(vendorId), { method: "POST", body }),
  update: (vendorId: string, id: string, body: Partial<{ name_ar: string; name_en: string | null; cover_url: string | null; visible: boolean }>) =>
    apiFetch<{ id: string }>(`${base(vendorId)}/${id}`, { method: "PATCH", body }),
  remove: (vendorId: string, id: string) => apiFetch(`${base(vendorId)}/${id}`, { method: "DELETE" }),
  reorder: (vendorId: string, ids: string[]) => apiFetch(`${base(vendorId)}/reorder`, { method: "POST", body: { section_ids: ids } }),
  add: (vendorId: string, id: string, offerIds: string[]) =>
    apiFetch<{ added: string[]; already_in: string[]; product_count: number }>(`${base(vendorId)}/${id}/offers`, { method: "POST", body: { offer_ids: offerIds } }),
  removeProducts: (vendorId: string, id: string, offerIds: string[]) =>
    apiFetch(`${base(vendorId)}/${id}/offers/remove`, { method: "POST", body: { offer_ids: offerIds } }),
  move: (vendorId: string, id: string, offerId: string, position: number) =>
    apiFetch(`${base(vendorId)}/${id}/offers/move`, { method: "POST", body: { offer_id: offerId, position } }),
  candidates: (vendorId: string, id: string, params: Record<string, string>) =>
    apiFetch<CandidatesPage>(`${base(vendorId)}/${id}/candidates?${new URLSearchParams(params).toString()}`),
  ofOffer: (vendorId: string, offerId: string) =>
    apiFetch<{ section_ids: string[] }>(`/vendors/${vendorId}/offers/${offerId}/sections`),
  setOfOffer: (vendorId: string, offerId: string, sectionIds: string[]) =>
    apiFetch<{ section_ids: string[] }>(`/vendors/${vendorId}/offers/${offerId}/sections`, { method: "PUT", body: { section_ids: sectionIds } }),
};

/** Why a linked product is not shown to shoppers (null = shown). */
export function notShownReason(item: { status: string; available: number; shown_to_shoppers?: boolean }): string | null {
  if (item.status !== "ACTIVE") return item.status;
  if (item.available <= 0) return "sold_out";
  return null;
}

/** The collection's name in the page language (Arabic when there is no English one). */
export function collectionName(c: { name_ar: string; name_en: string | null }, lang: string): string {
  return lang === "en" && c.name_en ? c.name_en : c.name_ar;
}
