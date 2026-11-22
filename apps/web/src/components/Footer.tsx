"use client";

import Link from "next/link";
import { SEGMENTS } from "@/lib/types";
import { registerTranslations, translate } from "@/lib/i18n";
import { useLang } from "@/lib/useLang";
import { segmentLabel } from "@/lib/shopText";

registerTranslations({
  ar: { "foot.about": "منصّة فلسطينية لاكتشاف الأزياء ومقارنة أسعارها بين متاجر محلية متعددة.", "foot.browse": "تصفّح", "foot.all_products": "كل المنتجات", "foot.following": "أتابعه", "foot.account": "حسابي", "foot.categories": "الفئات", "foot.rights": "جميع الحقوق محفوظة © FINALPRO" },
  en: { "foot.about": "A Palestinian platform for discovering fashion and comparing its prices across many local stores.", "foot.browse": "Browse", "foot.all_products": "All products", "foot.following": "Following", "foot.account": "My account", "foot.categories": "Categories", "foot.rights": "All rights reserved © FINALPRO" },
});

// Home-page footer: every link is a real route that already exists
// elsewhere in the app (discovery segments, following, account). No
// external/social links are invented - the platform has none today.
/** brand: the name shown in the footer (the trend and ads pages show VIA). */
export default function Footer({ brand = "FINALPRO" }: { brand?: string }) {
  const lang = useLang();
  const t = (key: string) => translate(lang, key);
  const segments = SEGMENTS.filter((s) => s.key !== "all");
  return (
    <footer className="site-footer">
      <div className="footer-grid">
        <div className="footer-col footer-brand">
          <span className="app-logo-mark">
            {brand}
          </span>
          <p>{t("foot.about")}</p>
        </div>

        <div className="footer-col">
          <h3>{t("foot.browse")}</h3>
          <Link href="/discovery">{t("foot.all_products")}</Link>
          <Link href="/following">{t("foot.following")}</Link>
          <Link href="/account">{t("foot.account")}</Link>
        </div>

        <div className="footer-col">
          <h3>{t("foot.categories")}</h3>
          {segments.map((s) => (
            <Link key={s.key} href={s.key === "women" ? "/women" : `/discovery?segment=${s.key}`}>
              {segmentLabel(lang, s.key, s.label)}
            </Link>
          ))}
        </div>
      </div>
      <div className="footer-bottom">
        <span>{t("foot.rights").replace("FINALPRO", brand)}</span>
      </div>
    </footer>
  );
}
