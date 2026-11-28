"use client";

import { getImageProps } from "next/image";
import { Cormorant_Garamond, IBM_Plex_Sans_Arabic, Inter, Noto_Naskh_Arabic } from "next/font/google";
import type { CSSProperties, MouseEvent } from "react";
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { useLang, useT } from "@/lib/useLang";
import { linkOf, mediaOf, mediaUrl, pickText, useManagedSection } from "@/lib/contentStudio";
import { HERO_PHOTOGRAPH, HERO_SCENES, HERO_SET_BACKGROUND } from "./heroScenes";
import ShopTheLook from "./ShopTheLook";
import "./heroCopy";
import styles from "./home-hero.module.css";

// Editorial pairing, scoped to the hero through CSS variables. Arabic
// headline: Noto Naskh Arabic (Noto's serif Arabic - there is no separate
// "Noto Serif Arabic" family); Arabic text: IBM Plex Sans Arabic. The Latin
// display face is only needed in English, so it is not preloaded.
const arDisplay = Noto_Naskh_Arabic({ subsets: ["arabic"], weight: ["400"], variable: "--hero-ar-display" });
const arText = IBM_Plex_Sans_Arabic({ subsets: ["arabic"], weight: ["400", "500"], variable: "--hero-ar-text" });
const enDisplay = Cormorant_Garamond({ subsets: ["latin"], weight: ["500"], variable: "--hero-en-display", preload: false });
const enText = Inter({ subsets: ["latin"], weight: ["400", "500"], variable: "--hero-en-text" });
const FONT_VARS = [arDisplay.variable, arText.variable, enDisplay.variable, enText.variable].join(" ");

// Phones and small tablets use the stacked composition (image, then text).
const STACKED_QUERY = "(max-width: 899px)";

// `sizes` = the width the cover-cropped 2.13:1 photos are actually drawn at
// (frame heights in home-hero.module.css): phones, a 60vw + 125px frame;
// wide screens, at least a 520px-tall frame.
const SIZES = "(max-width: 899px) calc(128vw + 266px), max(100vw, 1110px)";
// Above Next's default 75 (allowed in next.config.ts): the photo's soft light
// and silk gradients visibly band and blur at 75.
const QUALITY = 90;

/**
 * The film: a scene holds ("text", its own dwell), fades away ("leaving",
 * the CSS fade plus a beat), then the next scene - or, after a pagination
 * click, the chosen one (`next`) - plays. After the last scene it loops
 * back to the first, indefinitely.
 */
type Phase = "text" | "leaving";
const DWELL_MS = 5000;
const LEAVING_MS = 650;
// Interacting with Shop the look restarts its hold from this.
const INTERACT_HOLD_MS = 6000;
interface Playhead { scene: number; phase: Phase; next?: number }
const START: Playhead = { scene: 0, phase: "text" };

/** `count`: the scenes currently in the story (the loop wraps after them). */
function advance(p: Playhead, count: number): Playhead {
  if (p.phase === "text") return { scene: p.scene, phase: "leaving", next: p.next };
  return { scene: p.next ?? (p.scene + 1) % count, phase: "text" };
}

const REDUCED_QUERY = "(prefers-reduced-motion: reduce)";
function subscribeReduced(onChange: () => void) {
  const mq = window.matchMedia(REDUCED_QUERY);
  mq.addEventListener("change", onChange);
  return () => mq.removeEventListener("change", onChange);
}

export default function HomeHero() {
  const scenes = HERO_SCENES;
  const photo = HERO_PHOTOGRAPH;
  const lang = useLang();
  const t = useT();
  const hero = useManagedSection("home.hero");
  const reduced =useSyncExternalStore(subscribeReduced, () => window.matchMedia(REDUCED_QUERY).matches, () => false);
  const [playhead, setPlayhead] = useState<Playhead>(START);
  const [paused, setPaused] = useState(false);
  const [imageFailed, setImageFailed] = useState(false);
  // The set scenes (03, 04) join the story only once their background has
  // loaded; until then the story ends on the scene before them.
  const [setReady, setSetReady] = useState(false);
  const setBgRef = useRef<HTMLImageElement>(null);
  // Phones: Shop the look's toolbar renders here, under the photo.
  const [shopMobileSlot, setShopMobileSlot] = useState<HTMLDivElement | null>(null);
  // Time left in a phase when its timer is interrupted (a pause), so play
  // resumes rather than restarts. Tied to that playhead: a new one (the
  // story moving on, a pagination click) always starts its own full time.
  const remaining = useRef<{ playhead: Playhead; ms: number } | null>(null);
  // Set by an interaction in Shop the look: the next timer run holds the
  // scene for INTERACT_HOLD_MS from now. `holds` re-runs the timer.
  const interacted = useRef(false);
  const [holds, setHolds] = useState(0);
  // The scene whose hold an interaction restarted (drives the progress fill).
  const [heldScene, setHeldScene] = useState<number | null>(null);
  const dir = lang === "ar" ? "rtl" : "ltr";
  const firstSet = scenes.findIndex((s) => s.set);
  const lastScene = setReady || firstSet === -1 ? scenes.length - 1 : firstSet - 1;
  const sceneCount = lastScene + 1;
  const dwell = scenes[playhead.scene].dwell ?? DWELL_MS;

  // A cached background can finish loading before hydration (no onLoad).
  useEffect(() => {
    const img = setBgRef.current;
    if (img?.complete && img.naturalWidth > 0) setSetReady(true);
  }, []);

  useEffect(() => {
    // A transition that is under way (a pagination click while paused, say)
    // always completes; only holding a scene stops for a pause.
    if (reduced || sceneCount < 2 || (paused && playhead.phase === "text")) return;
    const saved = remaining.current?.playhead === playhead ? remaining.current.ms : null;
    let wait = saved ?? (playhead.phase === "text" ? dwell : LEAVING_MS);
    remaining.current = null;
    if (interacted.current && playhead.phase === "text") wait = INTERACT_HOLD_MS;
    interacted.current = false;
    const startedAt = performance.now();
    let fired = false;
    const id = window.setTimeout(() => {
      fired = true;
      setHeldScene(null);
      setPlayhead(advance(playhead, sceneCount));
    }, wait);
    return () => {
      window.clearTimeout(id);
      if (!fired) remaining.current = { playhead, ms: Math.max(0, wait - (performance.now() - startedAt)) };
    };
  }, [playhead, paused, reduced, sceneCount, dwell, holds]);

  const onShopInteract = useCallback(() => {
    interacted.current = true;
    remaining.current = null;
    setHeldScene(playhead.scene);
    setHolds((h) => h + 1);
  }, [playhead.scene]);

  /** Pagination: through the usual fade, straight to scene `i`. */
  function goTo(i: number) {
    if (i === playhead.scene && playhead.phase === "text") return;
    remaining.current = null;
    interacted.current = false;
    setHeldScene(null);
    // Reduced motion: no fade, just the scene.
    if (reduced) setPlayhead({ scene: i, phase: "text" });
    else setPlayhead({ scene: playhead.scene, phase: "leaving", next: i });
  }

  function onControl() {
    setPaused((p) => !p);
  }

  function onCta(e: MouseEvent<HTMLAnchorElement>, target: string) {
    const el = document.getElementById(target);
    if (!el) return; // the plain #anchor still works
    e.preventDefault();
    // The fixed header is already accounted for by the site's root
    // scroll-padding-top (globals.css), which the browser honours.
    const instant = window.matchMedia(REDUCED_QUERY).matches;
    el.scrollIntoView({ behavior: instant ? "auto" : "smooth" });
  }

  // One <picture>: the wide original, plus a dedicated phone image only when
  // there is one (otherwise the phone frame crops the original).
  // VIA phase 6: the Content Studio may manage the opening scene's copy,
  // button and photograph (same scene design). A photograph that is no
  // longer available falls back to the bundled one (a structural visual).
  // The bundled photograph itself is no override: it keeps its phone image.
  const managedUrl = hero.mode === "managed" ? mediaUrl(hero.section.fields.image, null) : null;
  const managedPhoto = managedUrl && managedUrl !== photo.image.src ? managedUrl : null;
  const managedAlt = hero.mode === "managed" ? pickText(mediaOf(hero.section.fields.image)?.alt, lang, "") : "";
  const alt = managedPhoto && managedAlt ? managedAlt : t(photo.image.altKey);
  const common = { alt, sizes: SIZES, quality: QUALITY };
  const desktop = managedPhoto
    ? getImageProps({ ...common, src: managedPhoto, width: photo.image.width, height: photo.image.height, unoptimized: /^https?:/.test(managedPhoto) })
    : getImageProps({ ...common, src: photo.image.src, width: photo.image.width, height: photo.image.height });
  const mobile =
    photo.mobileImage && !managedPhoto
      ? getImageProps({ ...common, src: photo.mobileImage.src, width: photo.mobileImage.width, height: photo.mobileImage.height })
      : null;
  const mobileFocus = photo.mobileImage?.focus ?? photo.image.focus.mobile;
  const setBg = getImageProps({ src: HERO_SET_BACKGROUND.src, width: HERO_SET_BACKGROUND.width, height: HERO_SET_BACKGROUND.height, alt: "", sizes: SIZES, quality: QUALITY });

  // The set is up while a set scene plays, and already on its way in (or
  // out) while a scene fades towards the next - so between set scenes it
  // never moves.
  const target = playhead.phase === "leaving" ? playhead.next ?? playhead.scene + 1 : playhead.scene;
  const setOn = Boolean(scenes[target]?.set);
  const closingOn = Boolean(scenes[playhead.scene].closing && playhead.phase === "text");

  if (hero.mode === "hidden") return null;
  const managedLines =
    hero.mode === "managed"
      ? pickText(hero.section.fields.headline, lang, "").split("\n").map((l) => l.trim()).filter(Boolean)
      : [];
  const managedDescription = hero.mode === "managed" ? pickText(hero.section.fields.subline, lang, "") : "";
  const managedCta = hero.mode === "managed" ? pickText(hero.section.fields.cta_label, lang, "") : "";
  // A link is a site path; "/#section" is a section of this page (in-page scroll).
  const managedLink = hero.mode === "managed" ? linkOf(hero.section.fields.cta_link, null) : null;
  const managedHref = managedLink?.startsWith("/#") ? managedLink.slice(1) : managedLink;

  return (
    <section
      className={`${styles.hero} ${FONT_VARS}`}
      style={{
        "--hero-backdrop": photo.backdrop,
        "--hero-ink": photo.ink,
        "--hero-focus-x": `${photo.image.focus.desktop.x * 100}%`,
        "--hero-focus-y": `${photo.image.focus.desktop.y * 100}%`,
        "--hero-focus-mx": `${mobileFocus.x * 100}%`,
        "--hero-focus-my": `${mobileFocus.y * 100}%`,
      } as CSSProperties}
      data-lang={lang}
      data-paused={paused || undefined}
      aria-label={t("hero.aria")}
    >
      <div className={styles.media}>
        {!imageFailed && (
          <picture>
            {mobile && <source media={STACKED_QUERY} srcSet={mobile.props.srcSet} sizes={SIZES} />}
            <img
              {...desktop.props}
              alt={alt}
              className={`${styles.image} ${styles.imageFirst}`}
              fetchPriority="high"
              loading={mobile ? "lazy" : "eager"}
              onError={() => setImageFailed(true)}
            />
          </picture>
        )}

        {/* The woman-free set (scenes 03-04): loaded right away at low
            priority; in the closing shot it drifts very slowly. */}
        <div className={styles.setLayer} data-on={setOn || undefined} data-closing={closingOn || undefined} aria-hidden="true">
          {/* eslint-disable-next-line @next/next/no-img-element -- optimised via getImageProps */}
          <img
            {...setBg.props}
            ref={setBgRef}
            alt=""
            className={styles.image}
            fetchPriority="low"
            loading="eager"
            onLoad={() => setSetReady(true)}
          />
        </div>

        {/* A faint warm light behind the text side (wide screens only),
            for legibility; it follows the scene's text side. */}
        <div className={styles.textScrim} data-side={scenes[target]?.text.side} aria-hidden="true" />

        {/* The photograph's foot dissolving into the page: above the
            photographs, below every scene's interface and the controls. */}
        <div className={styles.bottomFade} aria-hidden="true" />

        {scenes.map((scene, i) =>
          scene.shop ? (
            <ShopTheLook
              key={scene.id}
              shop={scene.shop}
              state={playhead.scene === i ? (playhead.phase === "text" ? "active" : "leaving") : "hidden"}
              paused={paused}
              reduced={reduced}
              t={t}
              quality={QUALITY}
              onInteract={onShopInteract}
              mobileSlot={shopMobileSlot}
            />
          ) : null,
        )}

        {!reduced && scenes.length > 1 && (
          <button
            type="button"
            className={styles.control}
            onClick={onControl}
            aria-label={t(paused ? "hero.play" : "hero.pause")}
          >
            <svg viewBox="0 0 24 24" aria-hidden="true">
              {paused ? (
                <path d="M8 5.5v13l10.5-6.5L8 5.5Z" />
              ) : (
                <path d="M9 5.5v13M15 5.5v13" />
              )}
            </svg>
          </button>
        )}
      </div>

      <div className={styles.copies}>
        {scenes.map((scene, i) => {
          const state = playhead.scene === i ? (playhead.phase === "text" ? "active" : "leaving") : "hidden";
          const Heading = i === 0 ? "h1" : "h2";
          const logo = scene.closing
            ? getImageProps({ src: scene.closing.logo.src, width: scene.closing.logo.width, height: scene.closing.logo.height, alt: t("hero.s04.logo"), sizes: "200px" })
            : null;
          return (
            <div
              key={scene.id}
              className={styles.copy}
              dir={dir}
              data-state={state}
              data-side={scene.text.side}
              data-compact={scene.text.compact || undefined}
              data-layout={scene.shop ? "shop" : scene.closing ? "closing" : undefined}
              aria-hidden={state !== "active" || undefined}
              inert={state !== "active"}
              style={{
                "--hero-text-inset": `${scene.text.inset * 100}%`,
                "--hero-copy-bottom": `${(1 - (scene.text.zoneBottom ?? 1)) * 100}%`,
              } as CSSProperties}
            >
              {scene.shop && <div ref={setShopMobileSlot} className={styles.shopMobileSlot} />}
              {logo && (
                <>
                  {/* eslint-disable-next-line @next/next/no-img-element -- the official logo file, as the header uses it */}
                  <img {...logo.props} alt={t("hero.s04.logo")} className={styles.closingLogo} />
                  <span className={styles.closingRule} aria-hidden="true" />
                </>
              )}
              {scene.label && (
                <p className={styles.label}>
                  {!scene.copy.index && <span className={styles.rule} aria-hidden="true" />}
                  <span dir="ltr">{scene.label}</span>
                </p>
              )}
              <Heading className={styles.title}>
                {(i === 0 && managedLines.length ? managedLines : scene.copy.titleKeys.map((key) => t(key))).map((text, line) => (
                  <span key={`${i}-${line}`} className={styles.titleMask}>
                    <span className={styles.titleLine} style={{ "--line": line } as CSSProperties}>
                      {text}
                    </span>
                  </span>
                ))}
              </Heading>
              <p className={styles.description}>{i === 0 && managedDescription ? managedDescription : t(scene.copy.descriptionKey)}</p>
              {i === 0 && managedHref && managedCta ? (
                <a
                  href={managedHref}
                  className={styles.cta}
                  onClick={(e) => managedHref.startsWith("#") && onCta(e, managedHref.slice(1))}
                >
                  <span>{managedCta}</span>
                  <svg className={styles.ctaArrow} viewBox="0 0 24 24" aria-hidden="true">
                    <path d="M5 12h14M13 6l6 6-6 6" />
                  </svg>
                </a>
              ) : scene.copy.ctaKey && scene.ctaTarget && (
                <a href={`#${scene.ctaTarget}`} className={styles.cta} onClick={(e) => onCta(e, scene.ctaTarget!)}>
                  <span>{t(scene.copy.ctaKey)}</span>
                  <svg className={styles.ctaArrow} viewBox="0 0 24 24" aria-hidden="true">
                    <path d="M5 12h14M13 6l6 6-6 6" />
                  </svg>
                </a>
              )}
              {scene.copy.index && (
                <p className={styles.indexRow}>
                  <span className={styles.rule} aria-hidden="true" />
                  <span dir="ltr">{scene.copy.index}</span>
                </p>
              )}
            </div>
          );
        })}
      </div>

      {/* One button per scene, the same order in both languages; the active
          one is a pill that fills as its scene plays. */}
      {sceneCount > 1 && (
        <nav className={styles.dots} aria-label={t("hero.dots")} dir="ltr">
          {scenes.slice(0, sceneCount).map((scene, i) => {
            const current = target === i;
            // While paused the fill stays and freezes (CSS: [data-paused]).
            const playing = current && playhead.phase === "text" && !reduced;
            return (
              <button
                key={scene.id}
                type="button"
                className={styles.dot}
                data-current={current || undefined}
                aria-current={current ? "step" : undefined}
                aria-label={t("hero.dots.item")
                  .replace("{n}", String(i + 1))
                  .replace("{total}", String(sceneCount))
                  .replace("{name}", t(scene.nameKey))}
                onClick={() => goTo(i)}
              >
                <span className={styles.dotMark}>
                  {playing && (
                    <span
                      key={`${playhead.scene}-${holds}`}
                      className={styles.dotFill}
                      style={{ "--fill-ms": `${heldScene === playhead.scene ? INTERACT_HOLD_MS : dwell}ms` } as CSSProperties}
                    />
                  )}
                </span>
              </button>
            );
          })}
        </nav>
      )}
    </section>
  );
}
