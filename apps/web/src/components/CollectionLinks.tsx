"use client";

import Link from "next/link";
import { collectionTitle, PublicCollection } from "@/lib/publicCollections";
import { useFetch } from "@/lib/useFetch";
import { useLang } from "@/lib/useLang";

/**
 * PD-5b.4: a small band of links to the live collections on the
 * discovery page - links only, no product cards on this page. The live
 * set is what the existing placements return (home + each department),
 * deduplicated in that order; nothing renders when there are none.
 */
export default function CollectionLinks() {
  const lang = useLang();
  const home = useFetch<{ items: PublicCollection[] }>("/collections?placement=HOME", true);
  const women = useFetch<{ items: PublicCollection[] }>("/collections?placement=AUDIENCE&audience=WOMEN", true);
  const men = useFetch<{ items: PublicCollection[] }>("/collections?placement=AUDIENCE&audience=MEN", true);
  const kids = useFetch<{ items: PublicCollection[] }>("/collections?placement=AUDIENCE&audience=KIDS", true);
  const seen = new Set<string>();
  const links = [home, women, men, kids]
    .flatMap((f) => f.data?.items ?? [])
    .filter((c) => (seen.has(c.slug) ? false : (seen.add(c.slug), true)));
  if (links.length === 0) return null;
  return (
    <nav className="collection-links" aria-label={lang === "en" ? "Collections" : "المجموعات"}>
      <span className="collection-links-label">{lang === "en" ? "Collections" : "مجموعات مختارة"}</span>
      {links.map((c) => (
        <Link key={c.slug} href={`/collections/${c.slug}`} className="category-chip collection-link-chip">
          {collectionTitle(c, lang)}
        </Link>
      ))}
    </nav>
  );
}
