import type { Metadata, Viewport } from "next";
import AppShell from "@/components/AppShell";
import ReturnFocus from "@/components/ReturnFocus";
import "./globals.css";

export const metadata: Metadata = {
  title: "Via - قارني الأسعار بين متاجر فلسطين",
  description: "منصّة مقارنة أسعار متعددة المتاجر: اكتشفي المنتجات وقارني الأسعار واشتري من المتجر الأنسب.",
  icons: {
    icon: "/images/via-logo.svg",
  },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  themeColor: "#12233f",
};

// Pages opened inside the owner's management modal or the account modal
// carry ?embed=management|account. AppShell learns that only in the
// browser (see useEmbedMode), so this plain inline <head> script runs
// while the document is parsed - before <body> is painted - and marks
// <html data-embed>; globals.css then hides the shell chrome until
// AppShell renders its bare embedded layout, so the iframe never flashes
// a header. (next/script's beforeInteractive only runs once the Next
// runtime has loaded - too late.) It reads only location.search and
// compares two fixed values.
const EMBED_BOOT_SCRIPT = `(function(){try{var e=new URLSearchParams(location.search).get("embed");if(e==="management"||e==="account")document.documentElement.setAttribute("data-embed",e)}catch(_){}})();`;

// RTL-first per the project's Arabic-default requirement - dir="rtl"
// lang="ar" on the root so every page inherits it. Sprint 13: every
// page renders inside the shared AppShell (header + bottom navigation).
export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    // suppressHydrationWarning: <html data-embed> is set by the boot
    // script before React hydrates.
    <html lang="ar" dir="rtl" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: EMBED_BOOT_SCRIPT }} />
      </head>
      <body>
        <AppShell>{children}</AppShell>
        <ReturnFocus />
      </body>
    </html>
  );
}
