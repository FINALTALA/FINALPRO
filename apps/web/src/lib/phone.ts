// Phase A++ (item 8): the ONE place the web cleans a typed phone number -
// the same rule as the API's apps/api/src/common/phone/phone-input.ts (the
// server cleans and validates again; it is the reference). Cleaning only:
// spaces, dashes, dots, brackets and slashes; invisible direction marks,
// zero-width characters and the BOM; Arabic-Indic (٠-٩) and Persian
// (۰-۹) digits to 0-9; "00" to "+". It never makes an invalid number
// valid - the server still requires strict E.164 (PHONE_INVALID otherwise).

const INVISIBLE = /[\u200B-\u200F\u202A-\u202E\u2060-\u2064\u2066-\u2069\uFEFF]/g;
const SEPARATORS = /[\s\u00A0\u2000-\u200A\u202F\u205F\u3000\-\u2010-\u2015\u2212.()[\]/]/g;

export function normalizePhoneInput(raw: string): string {
  let s = raw.replace(INVISIBLE, "").replace(SEPARATORS, "");
  s = s
    .replace(/[\u0660-\u0669]/g, (d) => String(d.charCodeAt(0) - 0x0660))
    .replace(/[\u06F0-\u06F9]/g, (d) => String(d.charCodeAt(0) - 0x06f0));
  s = s.replace(/[\uFF0B\u2795]/g, "+");
  if (s.startsWith("00")) s = `+${s.slice(2)}`;
  return s;
}

/** Strict E.164, as the API checks it. */
export const E164 = /^\+[1-9]\d{7,14}$/;
