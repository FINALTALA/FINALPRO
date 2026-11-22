// TB-25.3: the product page's colour choice by image. One thumbnail per
// colour, taken from that colour's own images: the first PRIMARY image
// among the colour's variants (in the order the API lists them), or - if
// none of them has a PRIMARY image - the first image by its sort order.
// A colour with no image at all gets null, and the page shows its colour
// circle instead. Pure: no state, no fetching, nothing about stock.

export interface ThumbMedia {
  url: string;
  kind: "PRIMARY" | "ADDITIONAL";
  media_type: "IMAGE" | "VIDEO";
  alt_text_ar: string | null;
  alt_text_en: string | null;
  sort_order: number;
}

export interface ThumbVariant {
  /** Product colours: the version's product colour (newer API); else its colour code. */
  color_id?: string | null;
  color_code?: string | null;
  media?: ThumbMedia[];
}

export interface ColorThumbnail {
  url: string;
  alt_ar: string | null;
  alt_en: string | null;
}

export function colorThumbnails(variants: ThumbVariant[], colorCodes: string[]): Record<string, ColorThumbnail | null> {
  const result: Record<string, ColorThumbnail | null> = {};
  for (const code of colorCodes) {
    const images = variants
      .filter((v) => (v.color_id ?? v.color_code) === code)
      .flatMap((v) => (v.media ?? []).filter((m) => m.media_type === "IMAGE"));
    const primary = images.find((m) => m.kind === "PRIMARY");
    const chosen = primary ?? [...images].sort((a, b) => a.sort_order - b.sort_order)[0] ?? null;
    result[code] = chosen ? { url: chosen.url, alt_ar: chosen.alt_text_ar, alt_en: chosen.alt_text_en } : null;
  }
  return result;
}
