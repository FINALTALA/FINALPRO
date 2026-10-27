import Link from "next/link";
import { SEGMENTS } from "@/lib/types";

// Home-page footer: every link is a real route that already exists
// elsewhere in the app (discovery segments, following, account). No
// external/social links are invented - the platform has none today.
/** brand: the name shown in the footer (the trend page shows VIA). */
export default function Footer({ brand = "FINALPRO" }: { brand?: string }) {
  const segments = SEGMENTS.filter((s) => s.key !== "all");
  return (
    <footer className="site-footer">
      <div className="footer-grid">
        <div className="footer-col footer-brand">
          <span className="app-logo-mark">
            {brand}
          </span>
          <p>منصّة فلسطينية لاكتشاف الأزياء ومقارنة أسعارها بين متاجر محلية متعددة.</p>
        </div>

        <div className="footer-col">
          <h3>تصفّح</h3>
          <Link href="/discovery">كل المنتجات</Link>
          <Link href="/following">أتابعه</Link>
          <Link href="/account">حسابي</Link>
        </div>

        <div className="footer-col">
          <h3>الفئات</h3>
          {segments.map((s) => (
            <Link key={s.key} href={s.key === "women" ? "/women" : `/discovery?segment=${s.key}`}>
              {s.label}
            </Link>
          ))}
        </div>
      </div>
      <div className="footer-bottom">
        <span>جميع الحقوق محفوظة © {brand}</span>
      </div>
    </footer>
  );
}
