"use client";

import { Cormorant_Garamond, Noto_Naskh_Arabic } from "next/font/google";
import type { ReactNode } from "react";
import { useLang } from "@/lib/useLang";
import styles from "./home-section-head.module.css";

// One section heading for every homepage section between the hero and the
// footer: the title at the reading start (right in Arabic), anything that
// belongs beside it (a subtitle, "view all", arrows) at the other end, and
// one quiet rule under the whole row spanning the section's content edges.
// Rendered as the section's direct <header> child, so the scroll reveal
// (useHomeReveal: "section[aria-labelledby] > header") still finds it.

// The homepage's title faces (same next/font settings as the sections, so
// the same files).
const arDisplay = Noto_Naskh_Arabic({ subsets: ["arabic"], weight: ["400"], variable: "--hsh-ar-display" });
const enDisplay = Cormorant_Garamond({ subsets: ["latin"], weight: ["500"], variable: "--hsh-en-display", preload: false });
const FONT_VARS = [arDisplay.variable, enDisplay.variable].join(" ");

type Props = {
  /** The <h2>'s id - the section's aria-labelledby target. */
  id: string;
  title: ReactNode;
  /** Shown at the row's far end: a subtitle, a "view all" link, nav buttons. */
  aside?: ReactNode;
  /** Extra class, for a section whose content is narrower than its box. */
  className?: string;
};

export default function HomeSectionHead({ id, title, aside, className }: Props) {
  const lang = useLang();
  return (
    <header className={`${styles.head} ${FONT_VARS}${className ? ` ${className}` : ""}`} data-lang={lang}>
      <h2 id={id} className={styles.title}>{title}</h2>
      {aside != null && <div className={styles.aside}>{aside}</div>}
    </header>
  );
}
