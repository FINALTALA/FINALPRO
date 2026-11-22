// PD-5b.4: the public platform collections (GET /collections*). The API
// decides everything - which collections are live, which products are
// buyable for the shopper's zone, their order; the UI only renders it.
import type { ComparisonCardDto } from "./types";
import { withEnglishFallback, type Lang } from "./i18n";

export interface PublicCollection {
  slug: string;
  title_ar: string;
  title_en: string;
  description_ar: string | null;
  description_en: string | null;
  audience: "WOMEN" | "MEN" | "KIDS" | null;
  products: ComparisonCardDto[];
}

export const collectionTitle = (c: PublicCollection, lang: Lang) => withEnglishFallback(lang, c.title_en, c.title_ar);
export const collectionDescription = (c: PublicCollection, lang: Lang) =>
  lang === "en" ? (c.description_en ?? c.description_ar) : c.description_ar;
