"use client";

import { linkOf, mediaOf, mediaUrl, pickText, useManagedSection, type ManagedValue } from "./contentStudio";
import { translate } from "./i18n";
import { useLang } from "./useLang";

// VIA phase 6 (extension) - the editorial parts of the Women, Men and Kids
// pages from the Content Studio: hero copy / images / button, the ticker
// phrases and the delivery-offer strip. Each page keeps its own markup and
// styles and passes its built-in values (translation keys and bundled
// images) as `builtIn`; the hook returns those values unchanged until a
// revision is published, the managed ones after, and null for a section
// that is unpublished or switched off. Category grid, collection showcase
// and product listing are the live catalogue and never come from here.

export type AudiencePage = "WOMEN" | "MEN" | "KIDS";
export interface AudienceBuiltIn {
  path: string; // the page route, e.g. "/women"
  title: string; // translation keys from here on
  copyStrong?: string;
  copySpan?: string;
  cta: string;
  ctaHref: string; // "#women-products"
  image: { src: string; alt?: string };
  titleArt?: string;
  subject?: string;
  tickerLabel: string;
  ticker: string[];
  offer: { pre: string; amount: string; mid: string; benefit: string; linkLabel: string; href: string };
}

/** A site link; "<this page>#section" becomes the in-page "#section". */
const local = (href: string | null, path: string, fallback: string) => {
  if (!href) return fallback;
  return href.startsWith(`${path}#`) ? href.slice(path.length) : href;
};

export function useAudienceEditorial(page: AudiencePage, b: AudienceBuiltIn) {
  const lang = useLang();
  const t = (k: string) => translate(lang, k);
  const p = page.toLowerCase();
  const hero = useManagedSection(`${p}.hero`);
  const ticker = useManagedSection(`${p}.ticker`);
  const offer = useManagedSection(`${p}.offer`);
  const txt = (v: ManagedValue | undefined, key: string | undefined) => pickText(v, lang, key ? t(key) : "");

  const heroOut =
    hero.mode === "hidden"
      ? null
      : hero.mode === "default"
        ? {
            title: t(b.title),
            copyStrong: b.copyStrong ? t(b.copyStrong) : "",
            copySpan: b.copySpan ? t(b.copySpan) : "",
            cta: t(b.cta),
            ctaHref: b.ctaHref,
            image: b.image.src,
            imageAlt: b.image.alt ? t(b.image.alt) : "",
            titleArt: b.titleArt ?? null,
            subject: b.subject ?? null,
          }
        : (() => {
            const f = hero.section.fields;
            return {
              title: txt(f.title, b.title),
              copyStrong: txt(f.copy_strong, b.copyStrong),
              copySpan: pickText(f.copy_span, lang, ""),
              cta: txt(f.cta_label, b.cta),
              ctaHref: local(linkOf(f.cta_link, null), b.path, b.ctaHref),
              // A structural image that is no longer available falls back to the bundled one.
              image: mediaUrl(f.image, b.image.src)!,
              imageAlt: pickText(mediaOf(f.image)?.alt, lang, b.image.alt ? t(b.image.alt) : ""),
              titleArt: b.titleArt ? mediaUrl(f.title_art, null) : null,
              subject: b.subject ? mediaUrl(f.subject, null) : null,
            };
          })();

  const tickerOut =
    ticker.mode === "hidden"
      ? null
      : ticker.mode === "default"
        ? { label: t(b.tickerLabel), items: b.ticker.map((k) => t(k)) }
        : {
            label: txt(ticker.section.fields.label, b.tickerLabel),
            items: ticker.section.items.map((it) => pickText(it.fields.text, lang, "")).filter(Boolean),
          };

  const offerOut =
    offer.mode === "hidden"
      ? null
      : offer.mode === "default"
        ? {
            pre: t(b.offer.pre),
            amount: t(b.offer.amount),
            mid: t(b.offer.mid),
            benefit: t(b.offer.benefit),
            linkLabel: t(b.offer.linkLabel),
            href: b.offer.href,
          }
        : (() => {
            const f = offer.section.fields;
            return {
              pre: txt(f.pre, b.offer.pre),
              amount: txt(f.amount, b.offer.amount),
              mid: txt(f.mid, b.offer.mid),
              benefit: txt(f.benefit, b.offer.benefit),
              linkLabel: txt(f.link_label, b.offer.linkLabel),
              href: local(linkOf(f.link, null), b.path, b.offer.href),
            };
          })();

  return { hero: heroOut, ticker: tickerOut && tickerOut.items.length ? tickerOut : null, offer: offerOut };
}

/** The built-in values of the three pages (shared by the pages and the initial import). */
export const AUDIENCE_BUILT_IN: Record<AudiencePage, AudienceBuiltIn> = {
  WOMEN: {
    path: "/women",
    title: "sec.women.title",
    cta: "sec.shop_now",
    ctaHref: "#women-products",
    image: { src: "/images/women-hero-runway.png" },
    titleArt: "/images/via-women-hero-title.svg",
    subject: "/images/women-hero-runway-subject.png",
    tickerLabel: "sec.f.ticker_aria",
    ticker: ["sec.f.ticker_1", "sec.f.ticker_2", "sec.ticker_3"],
    offer: { pre: "sec.f.offer_pre", amount: "sec.offer_amount", mid: "sec.f.offer_mid", benefit: "sec.offer_free", linkLabel: "sec.f.shop_now", href: "#women-products" },
  },
  MEN: {
    path: "/men",
    title: "sec.men.title",
    copyStrong: "sec.men.copy_strong",
    copySpan: "sec.men.copy_span",
    cta: "sec.shop_now",
    ctaHref: "#men-products",
    image: { src: "/images/men-hero.png", alt: "sec.men.hero_alt" },
    tickerLabel: "sec.m.ticker_aria",
    ticker: ["sec.m.ticker_1", "sec.m.ticker_2", "sec.ticker_3"],
    offer: { pre: "sec.m.offer_pre", amount: "sec.offer_amount", mid: "sec.m.offer_mid", benefit: "sec.offer_free", linkLabel: "sec.shop_now", href: "#men-products" },
  },
  KIDS: {
    path: "/kids",
    title: "sec.kids.title",
    copyStrong: "sec.kids.copy_strong",
    copySpan: "sec.kids.copy_span",
    cta: "sec.shop_now",
    ctaHref: "#women-products",
    image: { src: "/images/kids-hero-studio.png", alt: "sec.kids.hero_alt" },
    tickerLabel: "sec.f.ticker_aria",
    ticker: ["sec.f.ticker_1", "sec.f.ticker_2", "sec.ticker_3"],
    offer: { pre: "sec.f.offer_pre", amount: "sec.offer_amount", mid: "sec.f.offer_mid", benefit: "sec.offer_free", linkLabel: "sec.f.shop_now", href: "#women-products" },
  },
};
