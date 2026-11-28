"use client";

import "@/lib/adminNavText";
import "@/lib/workspaceText";
import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";
import { ADMIN_NAV_KEY_PREFIX } from "@/lib/adminNavText";
import { adminTiles } from "@/lib/nav";
import { useAdminGate } from "@/lib/useAdminGate";
import { useT } from "@/lib/useLang";
import styles from "./admin-shell.module.css";

// The platform workspace's own frame: VIA's identity (ink, cream, wine,
// gold) scoped to /admin only - every rule in admin-shell.module.css sits
// under .root, so no customer page is touched. The section links are the
// same role-filtered list the hub page shows (lib/nav.ts adminTiles);
// hiding one is UX only - the API authorizes every route. Labels follow
// the UI language (lib/adminNavText.ts).
const HUB = { href: "/admin", title: "نظرة عامة" };

function activeHref(pathname: string, hrefs: string[]): string | null {
  // The longest matching section wins (/admin/vendors/performance over
  // /admin/vendors); the hub matches only itself.
  let best: string | null = null;
  for (const href of hrefs) {
    const match = href === HUB.href ? pathname === href : pathname === href || pathname.startsWith(`${href}/`);
    if (match && (!best || href.length > best.length)) best = href;
  }
  return best;
}

export default function AdminLayout({ children }: { children: ReactNode }) {
  const gate = useAdminGate();
  const pathname = usePathname() ?? "";
  const t = useT();

  // Until the role is known (or for someone who is not platform staff) the
  // page renders its own skeleton / forbidden state, without the frame.
  if (gate.status !== "ok") {
    return <div className={styles.root}>{children}</div>;
  }

  const sections = [HUB, ...adminTiles(gate.role)];
  const active = activeHref(
    pathname,
    sections.map((s) => s.href),
  );
  // A section without its own label yet keeps its tile title - never a raw key.
  const label = (s: { href: string; title: string }) => {
    const key = `${ADMIN_NAV_KEY_PREFIX}${s.href}`;
    const text = t(key);
    return text === key ? s.title : text;
  };

  return (
    <div className={`${styles.root} ${styles.framed}`}>
      <aside className={styles.sidebar} aria-label={t("admin.frame.sections_aria")}>
        {/* The VIA logo is in the admin top bar (AppShell); one logo only. */}
        <div className={styles.brand}>
          <span className={styles.brandText}>
            <strong>{t("admin.frame.title")}</strong>
            <span>{t(`ws.enter.role.${gate.role}`)}</span>
          </span>
        </div>
        <nav className={styles.nav}>
          {sections.map((s) => (
            <Link
              key={s.href}
              href={s.href}
              className={`${styles.navLink}${s.href === active ? ` ${styles.navLinkActive}` : ""}`}
              aria-current={s.href === active ? "page" : undefined}
            >
              {label(s)}
            </Link>
          ))}
        </nav>
      </aside>
      <div className={styles.content}>{children}</div>
    </div>
  );
}
