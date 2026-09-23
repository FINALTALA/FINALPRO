import type { Metadata, Viewport } from "next";
import AppShell from "@/components/AppShell";
import "./globals.css";

export const metadata: Metadata = {
  title: "FINALPRO - قارني الأسعار بين متاجر فلسطين",
  description: "منصّة مقارنة أسعار متعددة المتاجر: اكتشفي المنتجات وقارني الأسعار واشتري من المتجر الأنسب.",
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  themeColor: "#12233f",
};

// RTL-first per the project's Arabic-default requirement - dir="rtl"
// lang="ar" on the root so every page inherits it. Sprint 13: every
// page renders inside the shared AppShell (header + bottom navigation).
export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="ar" dir="rtl">
      <body>
        <AppShell>{children}</AppShell>
      </body>
    </html>
  );
}
