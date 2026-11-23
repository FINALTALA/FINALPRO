import { addDays, hhmm, palestineParts, todayInPalestine, type OpeningState } from "./branchHours";
import { type Lang, registerTranslations, translate } from "./i18n";

/**
 * «ساعات العمل والإغلاقات v1»: the shopper-facing words for a branch's
 * opening state (the server's one rule - Palestine time, several periods a
 * day, a temporary closure always winning). Hours never block buying or
 * choosing pickup: outside them the order is prepared at the next opening.
 */

registerTranslations({
  ar: {
    "open.now_until": "مفتوح الآن حتى {time}",
    "open.reopens": "يفتح مجدداً {time}",
    "open.closed_now": "مغلق الآن",
    "open.prepared_at": "سيُجهَّز طلبك عند أقرب فتح للفرع: {time}",
    "open.next": "أقرب فتح: {time}",
    "open.today": "اليوم",
    "open.tomorrow": "غداً",
    "open.wd.0": "الأحد",
    "open.wd.1": "الاثنين",
    "open.wd.2": "الثلاثاء",
    "open.wd.3": "الأربعاء",
    "open.wd.4": "الخميس",
    "open.wd.5": "الجمعة",
    "open.wd.6": "السبت",
  },
  en: {
    "open.now_until": "Open now until {time}",
    "open.reopens": "reopens {time}",
    "open.closed_now": "Closed now",
    "open.prepared_at": "Your order will be prepared when the branch next opens: {time}",
    "open.next": "Next opening: {time}",
    "open.today": "today",
    "open.tomorrow": "tomorrow",
    "open.wd.0": "Sunday",
    "open.wd.1": "Monday",
    "open.wd.2": "Tuesday",
    "open.wd.3": "Wednesday",
    "open.wd.4": "Thursday",
    "open.wd.5": "Friday",
    "open.wd.6": "Saturday",
  },
});

const fill = (s: string, v: Record<string, string>) => s.replace(/\{(\w+)\}/g, (_, k: string) => v[k] ?? "");

/** "16:00", "غداً 09:00", "الخميس 09:00" or "الخميس 4/12 09:00" (Palestine time). */
export function openingWhen(iso: string, lang: Lang = "ar"): string {
  const t = (k: string) => translate(lang, k);
  const p = palestineParts(new Date(iso));
  const time = `⁦${hhmm(p.minute)}⁩`;
  const today = todayInPalestine();
  if (p.date === today) return time;
  if (p.date === addDays(today, 1)) return `${t("open.tomorrow")} ${time}`;
  const day = t(`open.wd.${p.dow}`);
  if (p.date <= addDays(today, 6)) return `${day} ${time}`;
  const [, m, d] = p.date.split("-");
  return `${day} ${Number(d)}/${Number(m)} ${time}`;
}

/** «مفتوح الآن حتى 14:00 · يفتح مجدداً 16:00» / «مغلق الآن · أقرب فتح: الخميس 09:00»; null = no hours set. */
export function openingLine(o: OpeningState | null | undefined, lang: Lang = "ar"): string | null {
  if (!o || o.open_now === null) return null;
  const t = (k: string) => translate(lang, k);
  if (o.open_now) {
    const head = fill(t("open.now_until"), { time: openingWhen(o.open_until!, lang) });
    return o.next_open_at ? `${head} · ${fill(t("open.reopens"), { time: openingWhen(o.next_open_at, lang) })}` : head;
  }
  return o.next_open_at ? `${t("open.closed_now")} · ${fill(t("open.next"), { time: openingWhen(o.next_open_at, lang) })}` : t("open.closed_now");
}

/** Pickup chosen while the branch is closed: «سيُجهَّز طلبك عند أقرب فتح للفرع: …»; null when open / unknown. */
export function pickupPreparedLine(o: OpeningState | null | undefined, lang: Lang = "ar"): string | null {
  if (!o || o.open_now !== false || !o.next_open_at) return null;
  return fill(translate(lang, "open.prepared_at"), { time: openingWhen(o.next_open_at, lang) });
}
