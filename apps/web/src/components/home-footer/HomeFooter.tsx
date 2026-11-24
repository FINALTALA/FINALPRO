"use client";

import Image from "next/image";
import Link from "next/link";
import { registerTranslations } from "@/lib/i18n";
import { useLang, useT } from "@/lib/useLang";
import styles from "./home-footer.module.css";

// Homepage footer. Every link is a route that already exists in the app;
// no contact details or social accounts are shown because the platform has
// none yet (add them here when they exist). The shared Footer used by the
// other pages is left as it is.

registerTranslations({
  ar: {
    "hf.aria": "تذييل الصفحة",
    "hf.tagline": "اكتشف الأزياء",
    "hf.about": "منصّة فلسطينية لاكتشاف الأزياء ومقارنة أسعارها بين متاجر محلية متعددة.",
    "hf.browse": "تصفّح",
    "hf.home": "الرئيسية",
    "hf.allProducts": "كل المنتجات",
    "hf.trending": "الترند",
    "hf.ads": "الإعلانات",
    "hf.sales": "التنزيلات",
    "hf.categories": "الفئات",
    "hf.women": "نساء",
    "hf.men": "رجال",
    "hf.kids": "أطفال",
    "hf.accessories": "إكسسوارات",
    "hf.watches": "ساعات",
    "hf.shoes": "أحذية",
    "hf.stores": "المتاجر وحسابي",
    "hf.discoverStores": "اكتشف المتاجر",
    "hf.following": "أتابعه",
    "hf.favorites": "المفضلة",
    "hf.account": "حسابي",
    "hf.rights": "جميع الحقوق محفوظة",
    "hf.terms": "شروط الاستخدام",
  },
  en: {
    "hf.aria": "Site footer",
    "hf.tagline": "Discover Fashion",
    "hf.about": "A Palestinian platform for discovering fashion and comparing prices across many local stores.",
    "hf.browse": "Browse",
    "hf.home": "Home",
    "hf.allProducts": "All products",
    "hf.trending": "Trending",
    "hf.ads": "Advertising",
    "hf.sales": "Sales",
    "hf.categories": "Categories",
    "hf.women": "Women",
    "hf.men": "Men",
    "hf.kids": "Kids",
    "hf.accessories": "Accessories",
    "hf.watches": "Watches",
    "hf.shoes": "Shoes",
    "hf.stores": "Stores & account",
    "hf.discoverStores": "Discover stores",
    "hf.following": "Following",
    "hf.favorites": "Favourites",
    "hf.account": "My account",
    "hf.rights": "All rights reserved",
    "hf.terms": "Terms of use",
  },
});

const COLUMNS: { title: string; links: { key: string; href: string }[] }[] = [
  {
    title: "hf.browse",
    links: [
      { key: "hf.home", href: "/" },
      { key: "hf.allProducts", href: "/discovery" },
      { key: "hf.trending", href: "/trending" },
      { key: "hf.ads", href: "/ads" },
      { key: "hf.sales", href: "/sales" },
    ],
  },
  {
    title: "hf.categories",
    links: [
      { key: "hf.women", href: "/women" },
      { key: "hf.men", href: "/men" },
      { key: "hf.kids", href: "/kids" },
      { key: "hf.accessories", href: "/discovery?segment=accessories" },
      { key: "hf.watches", href: "/discovery?segment=watches" },
      { key: "hf.shoes", href: "/discovery?segment=shoes" },
    ],
  },
  {
    title: "hf.stores",
    links: [
      // The Discover Stores section of the advertising page (no store
      // directory page exists yet).
      { key: "hf.discoverStores", href: "/ads#discover-stores-heading" },
      { key: "hf.following", href: "/following" },
      { key: "hf.favorites", href: "/account/favorites" },
      { key: "hf.account", href: "/account" },
    ],
  },
];

export default function HomeFooter() {
  const lang = useLang();
  const t = useT();
  const dir = lang === "ar" ? "rtl" : "ltr";

  return (
    <footer className={styles.root} data-lang={lang} dir={dir} aria-label={t("hf.aria")}>
      <div className={styles.inner}>
        <div className={styles.brandCol}>
          <Link href="/" className={styles.brand} aria-label="VIA">
            <Image src="/images/via-logo.svg" alt="" width={64} height={46} className={styles.logo} />
            <span className={styles.brandName}>ViA</span>
          </Link>
          <span className={styles.tagline}>{t("hf.tagline")}</span>
          <p className={styles.about}>{t("hf.about")}</p>
        </div>

        <nav className={styles.cols} aria-label={t("hf.aria")}>
          {COLUMNS.map((col) => (
            <div key={col.title} className={styles.col}>
              <h2 className={styles.colTitle}>{t(col.title)}</h2>
              <ul className={styles.links}>
                {col.links.map((l) => (
                  <li key={l.key}>
                    <Link href={l.href} className={styles.link}>{t(l.key)}</Link>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </nav>
      </div>

      <div className={styles.bottom}>
        <span>© {new Date().getFullYear()} VIA · {t("hf.rights")}</span>
        <Link href="/terms" className={styles.link}>{t("hf.terms")}</Link>
      </div>
    </footer>
  );
}
