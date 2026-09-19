import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "FINALPRO",
  description: "منصّة مقارنة متعددة المتاجر",
};

// Sprint 4 (RB-ROLE-005): RTL-first per the project's Arabic-default
// requirement - dir="rtl" lang="ar" on the root, not a per-page
// override, so every page (including ones built in later sprints)
// inherits it automatically.
export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="ar" dir="rtl">
      <body>{children}</body>
    </html>
  );
}
