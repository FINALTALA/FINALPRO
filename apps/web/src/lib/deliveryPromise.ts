// PD-5.1: wording for the delivery promise. The date, hours and the last
// day come from the API (the very slots checkout offers) - nothing here
// computes a date; it only formats one. Dates are calendar dates
// ("YYYY-MM-DD"), formatted in UTC so the browser's own timezone can
// never shift the day. TB-25: every wording takes the interface language
// (Arabic by default, unchanged).

type Lang = "ar" | "en";

export interface EarliestSlot {
  date: string;
  start_time: string;
  end_time: string;
}

export function formatSlotDay(date: string, lang: Lang = "ar"): string {
  return new Date(`${date}T00:00:00.000Z`).toLocaleDateString(lang === "en" ? "en-GB" : "ar-EG", {
    weekday: "long",
    day: "numeric",
    month: "long",
    timeZone: "UTC",
  });
}

/** «أقرب موعد توصيل: الخميس 29 أكتوبر، 10:00–12:00». */
export function earliestSlotText(slot: EarliestSlot, lang: Lang = "ar"): string {
  return lang === "en"
    ? `Earliest delivery: ${formatSlotDay(slot.date, lang)}, ${slotHours(slot)}`
    : `أقرب موعد توصيل: ${formatSlotDay(slot.date)}، ${slotHours(slot)}`;
}

/** The window's hours, "10:00–12:00" - render it as one LTR, unbroken unit. */
export function slotHours(slot: EarliestSlot): string {
  return `${slot.start_time}–${slot.end_time}`;
}

/** «ومواعيد أخرى حتى السبت 31 أكتوبر», or null. */
export function laterSlotsText(latestDate: string | null, lang: Lang = "ar"): string | null {
  if (!latestDate) return null;
  return lang === "en" ? `and other times until ${formatSlotDay(latestDate, lang)}` : `ومواعيد أخرى حتى ${formatSlotDay(latestDate)}`;
}

export const ESTIMATE_NOTE = "تقديري - تختارين الموعد عند الدفع، والحجز هو التأكيد النهائي";
const ESTIMATE_NOTE_EN = "An estimate - you choose the time at checkout, and the booking is the final confirmation";

export function estimateNote(lang: Lang = "ar"): string {
  return lang === "en" ? ESTIMATE_NOTE_EN : ESTIMATE_NOTE;
}

/** Today's real opening hours of a pickup branch («ساعات العمل والإغلاقات v1»: several periods a day). */
export function hoursTodayText(periods: { open: string; close: string }[], lang: Lang = "ar"): string {
  const list = periods.map((p) => `⁦${p.open}–${p.close}⁩`).join(lang === "en" ? ", " : "، ");
  if (lang === "en") return periods.length ? `open today ${list}` : "closed today";
  return periods.length ? `مفتوح اليوم ${list}` : "مغلق اليوم";
}
