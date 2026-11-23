"use client";

import { openingLine } from "@/lib/branchOpeningText";
import { type Lang, registerTranslations, translate } from "@/lib/i18n";
import { fmt } from "@/lib/shopText";
import { useLang } from "@/lib/useLang";
import "./storeHome.css";

/**
 * «معلومات المتجر» (Sprint 26, re-designed 2026-11-20): the end of the
 * store's «الكل» page - after the home blocks, before «تصفّحي المنتجات». The
 * SAME component in the owner's preview. Everything the original section
 * showed, nothing dropped or shortened and nothing guessed (GET
 * /storefronts/:slug/info: branches with their open-now state, weekly hours
 * and upcoming closures; delivery zones with fee and minimum order; the
 * return policy's mode, window and fees) - laid out as ONE section: a title,
 * then three balanced columns (branches and hours | delivery | returns and
 * exchanges) on a desktop, ordered stacked parts on a phone.
 */

export interface StoreInfoDto {
  is_available: boolean;
  branches: {
    id: string;
    name: string;
    is_physical: boolean;
    open_now: boolean | null;
    /** «ساعات العمل والإغلاقات v1»: the server's one rule (closures included) */
    open_until?: string | null;
    next_open_at?: string | null;
    hours: { day_of_week: number; open_minute: number; close_minute: number }[];
    upcoming_closures: { starts_at: string; ends_at: string }[];
  }[];
  delivery: { region: "WEST_BANK" | "JERUSALEM" | "INSIDE"; fee_ils: number; minimum_order_ils: number | null }[];
  returns: {
    mode: "NO_RETURN" | "REFUND_ONLY" | "EXCHANGE_ONLY" | "BOTH";
    window_days: number | null;
    fee_ils: number | null;
    exchange_fee_ils: number | null;
  } | null;
}

// Same Arabic labels as /vendor/[id]/delivery-zones and /return-policy.
registerTranslations({
  ar: {
    "info.title": "معلومات المتجر",
    "info.branches": "الفروع وساعات العمل",
    "info.branch": "فرع",
    "info.online": "متجر أونلاين",
    "info.open_now": "مفتوح الآن",
    "info.closed_now": "مغلق الآن",
    "info.closed": "مغلق",
    "info.no_hours": "لم يحدّد المتجر ساعات العمل بعد.",
    "info.closure": "إغلاق مؤقت:",
    "info.delivery": "التوصيل",
    "info.min_order": "الحد الأدنى للطلب {amount}",
    "info.no_delivery": "لم يحدّد المتجر مناطق التوصيل ورسومها بعد.",
    "info.returns": "الإرجاع والتبديل",
    "info.window": "خلال {n} يوماً من الاستلام",
    "info.return_fee": "رسوم الإرجاع",
    "info.exchange_fee": "رسوم التبديل",
    "info.period": "المهلة",
    "info.free": "مجاناً",
    "region.WEST_BANK": "الضفة الغربية",
    "region.JERUSALEM": "القدس",
    "region.INSIDE": "الداخل",
    "rmode.NO_RETURN": "لا يوجد إرجاع ولا تبديل",
    "rmode.REFUND_ONLY": "إرجاع مقابل استرداد المبلغ",
    "rmode.EXCHANGE_ONLY": "تبديل فقط",
    "rmode.BOTH": "إرجاع أو تبديل",
    "day.0": "الأحد",
    "day.1": "الإثنين",
    "day.2": "الثلاثاء",
    "day.3": "الأربعاء",
    "day.4": "الخميس",
    "day.5": "الجمعة",
    "day.6": "السبت",
  },
  en: {
    "info.title": "Store information",
    "info.branches": "Branches and opening hours",
    "info.branch": "Branch",
    "info.online": "Online store",
    "info.open_now": "Open now",
    "info.closed_now": "Closed now",
    "info.closed": "Closed",
    "info.no_hours": "The store hasn't set its opening hours yet.",
    "info.closure": "Temporary closure:",
    "info.delivery": "Delivery",
    "info.min_order": "minimum order {amount}",
    "info.no_delivery": "The store hasn't set its delivery zones and fees yet.",
    "info.returns": "Returns and exchanges",
    "info.window": "Within {n} days of receipt",
    "info.return_fee": "Return fee",
    "info.exchange_fee": "Exchange fee",
    "info.period": "Period",
    "info.free": "Free",
    "region.WEST_BANK": "West Bank",
    "region.JERUSALEM": "Jerusalem",
    "region.INSIDE": "Inside the Green Line",
    "rmode.NO_RETURN": "No returns or exchanges",
    "rmode.REFUND_ONLY": "Returns for a refund",
    "rmode.EXCHANGE_ONLY": "Exchanges only",
    "rmode.BOTH": "Return or exchange",
    "day.0": "Sunday",
    "day.1": "Monday",
    "day.2": "Tuesday",
    "day.3": "Wednesday",
    "day.4": "Thursday",
    "day.5": "Friday",
    "day.6": "Saturday",
  },
});

const DAYS = [0, 1, 2, 3, 4, 5, 6];
const WEEKDAY: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

function hhmm(minute: number): string {
  const h = Math.floor(minute / 60);
  const m = minute % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

function money(n: number, lang: Lang): string {
  const amount = n.toFixed(n % 1 === 0 ? 0 : 2);
  return lang === "en" ? `₪${amount}` : `${amount} ₪`;
}

function closureRange(c: { starts_at: string; ends_at: string }, lang: Lang): string {
  const format = new Intl.DateTimeFormat(lang === "en" ? "en-GB" : "ar", {
    timeZone: "Asia/Hebron",
    day: "numeric",
    month: "long",
    hour: "2-digit",
    minute: "2-digit",
  });
  return `${format.format(new Date(c.starts_at))} - ${format.format(new Date(c.ends_at))}`;
}

/** Today's day of the week in Palestine (0 = Sunday, Asia/Hebron like the API's own hours) - only to mark today's row. */
function todayInPalestine(): number {
  const name = new Intl.DateTimeFormat("en-US", { timeZone: "Asia/Hebron", weekday: "short" }).format(new Date());
  return WEEKDAY[name] ?? new Date().getDay();
}

const Icon = {
  branches: (
    <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true"><path d="M12 21s-6.5-5.6-6.5-11a6.5 6.5 0 0 1 13 0C18.5 15.4 12 21 12 21Z" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" /><circle cx="12" cy="10" r="2.3" fill="none" stroke="currentColor" strokeWidth="1.6" /></svg>
  ),
  delivery: (
    <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true"><path d="M3 7h10v9H3zM13 10h4l3 3v3h-7z" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" /><circle cx="7" cy="17.5" r="1.7" fill="#fffaf3" stroke="currentColor" strokeWidth="1.6" /><circle cx="17" cy="17.5" r="1.7" fill="#fffaf3" stroke="currentColor" strokeWidth="1.6" /></svg>
  ),
  returns: (
    <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true"><path d="M4 9h11a5 5 0 0 1 0 10H9" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" /><path d="M8 5 4 9l4 4" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" /></svg>
  ),
};

export default function StoreInfoSection({ info }: { info: StoreInfoDto }) {
  const lang = useLang();
  const t = (key: string) => translate(lang, key);
  const r = info.returns;
  // as before: nothing at all is shown only when the store is unavailable or has none of the three
  const hasAnything = info.branches.length > 0 || info.delivery.length > 0 || r !== null;
  if (!info.is_available || !hasAnything) return null;
  const today = todayInPalestine();

  return (
    <section className="si" aria-labelledby="store-info-title" data-testid="store-info">
      <h2 id="store-info-title" className="si-title">{t("info.title")}</h2>
      <div className="si-list">
        {info.branches.length > 0 && (
          <section className="si-item" data-part="branches" aria-labelledby="si-branches">
            <header className="si-item-head">
              <span className="si-icon" aria-hidden="true">{Icon.branches}</span>
              <h3 className="si-head" id="si-branches">{t("info.branches")}</h3>
            </header>
            <ul className="si-branches">
              {info.branches.map((b) => (
                <li key={b.id} className="si-branch" data-testid={`store-info-branch-${b.id}`}>
                  <div className="si-branch-head">
                    <strong className="si-branch-name">{b.name}</strong>
                    <span className="si-muted">{b.is_physical ? t("info.branch") : t("info.online")}</span>
                    {b.open_now !== null && (
                      <span className={`si-state${b.open_now ? " is-open" : ""}`}>{b.open_now ? t("info.open_now") : t("info.closed_now")}</span>
                    )}
                  </div>
                  {b.open_now !== null && b.open_until !== undefined && (
                    <p className="si-opening" data-testid="store-info-opening">{openingLine({ open_now: b.open_now, open_until: b.open_until ?? null, next_open_at: b.next_open_at ?? null }, lang)}</p>
                  )}
                  {b.hours.length > 0 ? (
                    <ul className="si-hours">
                      {DAYS.map((i) => {
                        // «ساعات العمل والإغلاقات v1»: a day may have several periods
                        const periods = b.hours.filter((x) => x.day_of_week === i).sort((x, y) => x.open_minute - y.open_minute);
                        return (
                          <li key={i} className={i === today ? "is-today" : undefined}>
                            <span>{t(`day.${i}`)}</span>
                            <span dir="ltr">{periods.length ? periods.map((h) => `${hhmm(h.open_minute)} - ${hhmm(h.close_minute)}`).join(", ") : t("info.closed")}</span>
                          </li>
                        );
                      })}
                    </ul>
                  ) : (
                    <p className="si-note">{t("info.no_hours")}</p>
                  )}
                  {b.upcoming_closures.length > 0 && (
                    <p className="si-closure">
                      <strong>{t("info.closure")}</strong>
                      {b.upcoming_closures.map((c) => (
                        <span key={c.starts_at}>{closureRange(c, lang)}</span>
                      ))}
                    </p>
                  )}
                </li>
              ))}
            </ul>
          </section>
        )}

        <section className="si-item" data-part="delivery" aria-labelledby="si-delivery">
          <header className="si-item-head">
            <span className="si-icon" aria-hidden="true">{Icon.delivery}</span>
            <h3 className="si-head" id="si-delivery">{t("info.delivery")}</h3>
          </header>
          {info.delivery.length > 0 ? (
            <ul className="si-rows">
              {info.delivery.map((z) => (
                <li key={z.region}>
                  <span>{t(`region.${z.region}`)}</span>
                  <span className="si-value">
                    <strong>{z.fee_ils === 0 ? t("info.free") : money(z.fee_ils, lang)}</strong>
                    {z.minimum_order_ils !== null && <small className="si-muted">{fmt(t("info.min_order"), { amount: money(z.minimum_order_ils, lang) })}</small>}
                  </span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="si-note">{t("info.no_delivery")}</p>
          )}
        </section>

        {r && (
          <section className="si-item" data-part="returns" aria-labelledby="si-returns">
            <header className="si-item-head">
              <span className="si-icon" aria-hidden="true">{Icon.returns}</span>
              <h3 className="si-head" id="si-returns">{t("info.returns")}</h3>
            </header>
            <p className="si-mode">{t(`rmode.${r.mode}`)}</p>
            {r.mode !== "NO_RETURN" && (
              <ul className="si-rows">
                {r.window_days !== null && (
                  <li>
                    <span>{t("info.period")}</span>
                    <span className="si-value">{fmt(t("info.window"), { n: r.window_days })}</span>
                  </li>
                )}
                {(r.mode === "REFUND_ONLY" || r.mode === "BOTH") && (
                  <li>
                    <span>{t("info.return_fee")}</span>
                    <strong className="si-value">{r.fee_ils ? money(r.fee_ils, lang) : t("info.free")}</strong>
                  </li>
                )}
                {(r.mode === "EXCHANGE_ONLY" || r.mode === "BOTH") && (
                  <li>
                    <span>{t("info.exchange_fee")}</span>
                    <strong className="si-value">{r.exchange_fee_ils ? money(r.exchange_fee_ils, lang) : t("info.free")}</strong>
                  </li>
                )}
              </ul>
            )}
          </section>
        )}
      </div>
    </section>
  );
}
