// Sprint 14: customer address entry - pure validation/normalisation so it
// can be unit-tested without a browser. The server (CreateAddressDto)
// is the real validator; this only gives the customer fast, clear
// feedback before a request is made.
//
// Sprint 22: AddressForm (the only caller of this module) is shared UI
// reused by both the pre-S22 /account page and the new S22 addresses
// screen, so its labels/errors are bilingual - `lang` is threaded
// through rather than hardcoding Arabic.

import type { Lang } from "./i18n";

export type ZoneValue = "WEST_BANK" | "JERUSALEM" | "INSIDE";

const ZONE_LABELS: Record<Lang, Record<ZoneValue, string>> = {
  ar: { WEST_BANK: "الضفة الغربية", JERUSALEM: "القدس", INSIDE: "الداخل" },
  en: { WEST_BANK: "West Bank", JERUSALEM: "Jerusalem", INSIDE: "Inside the Green Line" },
};

export function zoneOptions(lang: Lang): { value: ZoneValue; label: string }[] {
  return (Object.keys(ZONE_LABELS[lang]) as ZoneValue[]).map((value) => ({
    value,
    label: ZONE_LABELS[lang][value],
  }));
}

export interface AddressFormValues {
  label: string;
  lat: string;
  lng: string;
  landmark: string;
  phone1: string;
  phone2: string;
  zone: ZoneValue | "";
}

export interface AddressRequestBody {
  label?: string;
  lat: number;
  lng: number;
  landmark_note?: string;
  phone_number_1: string;
  phone_number_2?: string;
  zone: ZoneValue;
}

export type AddressValidation =
  | { ok: true; body: AddressRequestBody }
  | { ok: false; errors: Partial<Record<keyof AddressFormValues, string>> };

/** "059xxxxxxx" / "056xxxxxxx" -> "+97059xxxxxxx"; anything else is returned trimmed. */
export function normalisePhone(raw: string): string {
  const compact = raw.replace(/[\s-]/g, "");
  if (/^0\d{9}$/.test(compact)) return `+970${compact.slice(1)}`;
  if (/^00970\d{9}$/.test(compact)) return `+${compact.slice(2)}`;
  return compact;
}

const PHONE_PATTERN = /^\+\d{8,15}$/;

const VALIDATION_MESSAGES: Record<Lang, Record<"lat" | "lng" | "phone1" | "phone2" | "zone", string>> = {
  ar: {
    lat: "خط العرض يجب أن يكون رقماً بين -90 و 90",
    lng: "خط الطول يجب أن يكون رقماً بين -180 و 180",
    phone1: "أدخلي رقم هاتف صحيحاً مثل +970591234567",
    phone2: "رقم الهاتف الثاني غير صحيح",
    zone: "اختاري منطقة التوصيل",
  },
  en: {
    lat: "Latitude must be a number between -90 and 90",
    lng: "Longitude must be a number between -180 and 180",
    phone1: "Enter a valid phone number, e.g. +970591234567",
    phone2: "The second phone number is invalid",
    zone: "Choose a delivery zone",
  },
};

export function validateAddress(v: AddressFormValues, lang: Lang = "ar"): AddressValidation {
  const errors: Partial<Record<keyof AddressFormValues, string>> = {};
  const messages = VALIDATION_MESSAGES[lang];

  const lat = Number(v.lat.trim());
  if (v.lat.trim() === "" || !Number.isFinite(lat) || lat < -90 || lat > 90) {
    errors.lat = messages.lat;
  }
  const lng = Number(v.lng.trim());
  if (v.lng.trim() === "" || !Number.isFinite(lng) || lng < -180 || lng > 180) {
    errors.lng = messages.lng;
  }

  const phone1 = normalisePhone(v.phone1);
  if (!PHONE_PATTERN.test(phone1)) {
    errors.phone1 = messages.phone1;
  }
  const phone2 = v.phone2.trim() === "" ? "" : normalisePhone(v.phone2);
  if (phone2 !== "" && !PHONE_PATTERN.test(phone2)) {
    errors.phone2 = messages.phone2;
  }

  if (v.zone === "") {
    errors.zone = messages.zone;
  }

  if (Object.keys(errors).length > 0) return { ok: false, errors };

  return {
    ok: true,
    body: {
      ...(v.label.trim() !== "" ? { label: v.label.trim() } : {}),
      lat,
      lng,
      ...(v.landmark.trim() !== "" ? { landmark_note: v.landmark.trim() } : {}),
      phone_number_1: phone1,
      ...(phone2 !== "" ? { phone_number_2: phone2 } : {}),
      zone: v.zone as ZoneValue,
    },
  };
}

/** Rounds a browser coordinate to a sensible precision for the form fields. */
export function formatCoordinate(value: number): string {
  return value.toFixed(6);
}
