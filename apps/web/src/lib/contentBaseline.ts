"use client";

// VIA phase 6 - the initial Content Studio import ("revision 1"). Built from
// the very same built-in data and translations the public renderers fall
// back to, so the first published revision renders exactly the current
// pages: same ids (each managed item keeps its built-in layout), same
// bundled media (no re-upload), same copy. Repeatable: the admin "Import
// current content" action posts baselineDocument(page) once per page.
//
// Copy that the current design shows in one language only keeps the other
// language empty (the renderer falls back to the shown one, as today); the
// editor then reports the missing translation before the next publication.

import { HERO_PHOTOGRAPH, HERO_SCENES } from "@/components/home-hero/heroScenes";
import "@/components/home-hero/heroCopy";
import "@/components/home-stories/HomeStories";
import { HOME_STORIES } from "@/components/home-stories/storyData";
import "@/components/home-products/HomeProducts";
import { CATEGORIES } from "@/components/home-categories/HomeCategories";
import { STEPS } from "@/components/home-how-via/HomeHowVia";
import { PIECES } from "@/components/trend/TrendLook";
import { FEATURED_FILMS, GALLERY } from "@/components/trend/collections";
import "@/components/ads/adsCopy";
import { DEMO_FEATURED_STORES, FEATURED_ADS, HERO_SLIDES, REELS, STORY_GROUPS } from "@/components/ads/data/adsDemo";
import { AUDIENCE_BUILT_IN, type AudiencePage } from "./audienceEditorial";
import { translate } from "./i18n";
import "./sectionText";

type Bi = { ar: string; en: string };
type Media = { source: "bundled"; path: string; alt: Bi };
type Doc = {
  schemaVersion: 1;
  sections: { id: string; key: string; enabled: boolean; fields: Record<string, unknown>; items: { id: string; fields: Record<string, unknown> }[] }[];
};

const tr = (key: string): Bi => ({ ar: translate("ar", key), en: translate("en", key) });
const lines = (keys: string[]): Bi => ({
  ar: keys.map((k) => translate("ar", k)).join("\n"),
  en: keys.map((k) => translate("en", k)).join("\n"),
});
const arOnly = (ar: string): Bi => ({ ar, en: "" });
const media = (path: string, alt: Bi): Media => ({ source: "bundled", path, alt });
const section = (key: string, fields: Record<string, unknown>, items: Doc["sections"][number]["items"] = []) => ({
  id: key.replace(".", "-"),
  key,
  enabled: true,
  fields,
  items,
});

function homepage(): Doc {
  const opening = HERO_SCENES[0];
  return {
    schemaVersion: 1,
    sections: [
      section("home.hero", {
        headline: lines(opening.copy.titleKeys),
        subline: tr(opening.copy.descriptionKey),
        cta_label: opening.copy.ctaKey ? tr(opening.copy.ctaKey) : null,
        cta_link: opening.ctaTarget ? { href: `/#${opening.ctaTarget}` } : null,
        image: media(HERO_PHOTOGRAPH.image.src, tr(HERO_PHOTOGRAPH.image.altKey)),
      }),
      section(
        "home.stories",
        { heading: tr("hst.title") },
        // Informative alt (required for publication): the story's own title.
        HOME_STORIES.map((s) => ({
          id: s.id,
          fields: { label: tr(`${s.key}.cat`), title: tr(`${s.key}.title`), image: media(s.image.src, tr(`${s.key}.title`)) },
        })),
      ),
      // No picks: the Discover tab keeps its built-in curated pieces.
      section("home.picks", { heading: tr("hp.title") }),
      section(
        "home.categories",
        { heading: tr("cats.title") },
        CATEGORIES.map((c) => ({
          id: c.key,
          fields: { label: tr(`cats.${c.key}.cta`), image: media(c.image.src, tr(`cats.${c.key}.alt`)), link: { href: c.href } },
        })),
      ),
      section(
        "home.how",
        { heading: tr("hv.title") },
        STEPS.map((s) => ({
          id: `step-${s.n}`,
          fields: { title: tr(`hv.${s.n}.title`), text: tr(`hv.${s.n}.body`), image: media(s.image.src, tr(`hv.${s.n}.alt`)) },
        })),
      ),
    ],
  };
}

function trending(): Doc {
  return {
    schemaVersion: 1,
    sections: [
      // The title panel's built-in copy (TrendStage) is Arabic in both languages.
      section("trend.hero", { headline: arOnly("الشتا\nعلى طريقتك"), subline: arOnly("الطقم الخمري، بطريقتك.") }),
      section(
        "trend.look",
        { heading: { ar: "إطلالة الأسبوع", en: "LOOK OF THE WEEK" }, subline: null },
        PIECES.map((p) => ({
          id: p.key,
          fields: { title: arOnly(p.name), image: media(`/trend/look/${p.img}.webp`, arOnly(p.alt)), product: null },
        })),
      ),
      section(
        "trend.reels",
        { heading: { ar: "مجموعات جديدة", en: "NEW COLLECTIONS" } },
        FEATURED_FILMS.map((f) => ({
          id: f.key,
          fields: { title: { ar: f.titleAr, en: f.title }, video: media(f.video, { ar: f.titleAr, en: f.title }) },
        })),
      ),
      // The gallery shows its Latin title and, under it, the Arabic lead line.
      section(
        "trend.collections",
        { heading: { ar: "مجموعات مختارة بحسب الأسلوب والمزاج، من الكتّان الهادئ إلى الذهب.", en: "DISCOVER THE COLLECTIONS" } },
        GALLERY.map((g) => ({
          id: g.key,
          fields: {
            title: { ar: g.titleAr, en: g.title },
            image: media(`${g.src}.webp`, arOnly(g.alt)),
            collection: null,
            link: typeof g.href === "string" ? { href: g.href } : null,
          },
        })),
      ),
    ],
  };
}

function ads(): Doc {
  // Demo placeholder stores are not Via stores: no store reference (the
  // built-in card keeps its placeholder identity, marked as demo).
  return {
    schemaVersion: 1,
    sections: [
      section(
        "ads.hero",
        {},
        HERO_SLIDES.map((s) => ({
          id: s.id,
          fields: { title: s.title, text: s.subtitle, image: media(s.image.src, s.alt), link: null },
        })),
      ),
      section(
        "ads.stories",
        { heading: tr("ads.stories.title") },
        STORY_GROUPS.map((g) => ({
          id: g.store.id,
          fields: { title: g.stories[0]?.caption ?? g.store.name, image: media(g.cover, g.stories[0]?.caption ?? g.store.name), store: null },
        })),
      ),
      section(
        "ads.reels",
        { heading: tr("ads.reels.heading") },
        REELS.map((r) => ({ id: r.id, fields: { title: r.title, video: media(r.video, r.title), store: null } })),
      ),
      section(
        "ads.featured",
        { heading: tr("ads.featured.heading") },
        FEATURED_ADS.map((a) => ({
          id: a.id,
          fields: { title: a.title, text: a.subtitle, image: media(a.image.src, a.alt), link: a.href ? { href: a.href } : null, store: null },
        })),
      ),
      section(
        "ads.stores",
        { heading: tr("ads.stores.heading") },
        DEMO_FEATURED_STORES.map((s) => ({ id: s.store.id, fields: { store: null, image: media(s.cover, s.coverAlt) } })),
      ),
    ],
  };
}

/** Women / Men / Kids: hero, ticker and offer strip, from the values the pages render today (lib/audienceEditorial.ts). */
function audience(page: AudiencePage): Doc {
  const b = AUDIENCE_BUILT_IN[page];
  const p = page.toLowerCase();
  const hero: Record<string, unknown> = {
    title: tr(b.title),
    cta_label: tr(b.cta),
    cta_link: { href: `${b.path}${b.ctaHref}` },
    // Women's hero pictures are decorative (alt="" today); Men / Kids keep their alt text.
    image: media(b.image.src, b.image.alt ? tr(b.image.alt) : { ar: "", en: "" }),
  };
  if (b.copyStrong) hero.copy_strong = tr(b.copyStrong);
  if (b.copySpan) hero.copy_span = tr(b.copySpan);
  if (b.titleArt) hero.title_art = media(b.titleArt, { ar: "", en: "" });
  if (b.subject) hero.subject = media(b.subject, { ar: "", en: "" });
  return {
    schemaVersion: 1,
    sections: [
      section(`${p}.hero`, hero),
      section(
        `${p}.ticker`,
        { label: tr(b.tickerLabel) },
        b.ticker.map((k, i) => ({ id: `phrase-${i + 1}`, fields: { text: tr(k) } })),
      ),
      section(`${p}.offer`, {
        pre: tr(b.offer.pre),
        amount: tr(b.offer.amount),
        mid: tr(b.offer.mid),
        benefit: tr(b.offer.benefit),
        link_label: tr(b.offer.linkLabel),
        link: { href: `${b.path}${b.offer.href}` },
      }),
    ],
  };
}

export type ContentPageKey = "HOMEPAGE" | "TRENDING" | "ADS" | AudiencePage;
export function baselineDocument(page: ContentPageKey): Doc {
  if (page === "WOMEN" || page === "MEN" || page === "KIDS") return audience(page);
  return page === "HOMEPAGE" ? homepage() : page === "TRENDING" ? trending() : ads();
}
