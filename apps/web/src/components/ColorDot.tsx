import { swatchBackground } from "@/lib/colorName";

/**
 * Product colours: the small colour circle next to a colour's name (cart,
 * orders): the fabric swatch, else the colour's HEX, else its family's
 * colour. Decorative - the name beside it says the colour in words.
 */
export default function ColorDot({ swatchUrl, hex, familyHex }: { swatchUrl?: string | null; hex?: string | null; familyHex?: string | null }) {
  const background = swatchBackground({ swatch_url: swatchUrl, hex, family_hex: familyHex });
  if (background === "transparent") return null;
  return <span className="color-dot" style={{ background }} aria-hidden="true" />;
}
