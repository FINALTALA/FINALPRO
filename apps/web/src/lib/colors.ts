// Colour names as vendors enter them (Arabic or English) mapped to a
// display swatch. A colour with no entry renders as a text chip instead
// - never a guessed swatch.
export const COLOR_SWATCHES: Record<string, string> = {
  "أبيض": "#ffffff", "ابيض": "#ffffff", white: "#ffffff",
  "أسود": "#1c1416", "اسود": "#1c1416", black: "#1c1416",
  "أزرق": "#47698b", "ازرق": "#47698b", blue: "#47698b",
  "كحلي": "#1f2c3e", navy: "#1f2c3e",
  "وردي": "#e8c8c4", pink: "#e8c8c4",
  "خمري": "#4a1626", "نبيذي": "#4a1626", burgundy: "#4a1626",
  "بيج": "#d7c6ad", beige: "#d7c6ad",
  "بني": "#78533b", brown: "#78533b",
  "رمادي": "#88827f", gray: "#88827f", grey: "#88827f",
  "أخضر": "#50755e", "اخضر": "#50755e", green: "#50755e",
  "أحمر": "#a33437", "احمر": "#a33437", red: "#a33437",
  "ذهبي": "#c9a44c", gold: "#c9a44c",
  "فضي": "#c4c6c8", silver: "#c4c6c8",
  "كريمي": "#f1e8d8", cream: "#f1e8d8",
  "برتقالي": "#d9772b", orange: "#d9772b",
  "أصفر": "#d8b530", "اصفر": "#d8b530", yellow: "#d8b530",
  "زيتي": "#6b6b3a", olive: "#6b6b3a",
  "ليلكي": "#b9a3d0", lilac: "#b9a3d0",
};

export function swatchFor(color: string): string | null {
  return COLOR_SWATCHES[color.trim().toLowerCase()] ?? null;
}
