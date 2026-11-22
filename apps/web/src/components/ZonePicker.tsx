"use client";

import { zoneOptions, type ZoneValue } from "@/lib/address";
import type { Lang } from "@/lib/i18n";

/** "" = the server's default (the account's default address zone); "ALL" or a zone = the shopper's own choice. */
export type ZoneChoice = "" | "ALL" | ZoneValue;

/** The zone the API applied, as public reads return it (PD-2). */
export interface FulfilmentContext {
  zone: ZoneValue | null;
  zone_source: "REQUEST" | "DEFAULT_ADDRESS" | "NONE";
  default_zone: ZoneValue | null;
}

/**
 * PD-2: the delivery-area picker shared by the product page and a
 * platform collection page. It only chooses what is sent as `?zone=` -
 * the API applies it (or the default address zone when nothing is
 * chosen; never GPS). "My address" is labelled from the server's
 * `default_zone`, so a visitor or an account without a default address
 * sees "choose an area".
 */
export default function ZonePicker({
  value,
  onChange,
  defaultZone,
  lang = "ar",
  className,
}: {
  value: ZoneChoice;
  onChange: (value: ZoneChoice) => void;
  defaultZone: ZoneValue | null;
  lang?: Lang;
  className?: string;
}) {
  const en = lang === "en";
  const zones = zoneOptions(lang);
  const defaultLabel = zones.find((z) => z.value === defaultZone)?.label;
  return (
    <select
      className={className}
      aria-label={en ? "Delivery area" : "منطقة التوصيل"}
      value={value}
      onChange={(e) => onChange(e.target.value as ZoneChoice)}
    >
      <option value="">
        {defaultLabel ? (en ? `My address (${defaultLabel})` : `عنواني (${defaultLabel})`) : en ? "Choose an area" : "اختاري المنطقة"}
      </option>
      <option value="ALL">{en ? "All areas" : "كل المناطق"}</option>
      {zones.map((z) => (
        <option key={z.value} value={z.value}>{z.label}</option>
      ))}
    </select>
  );
}
