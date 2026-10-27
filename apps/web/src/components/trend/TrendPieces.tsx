"use client";

import { IBM_Plex_Sans_Arabic, Inter_Tight, Syne } from "next/font/google";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import TrendEditorialHead from "./TrendEditorialHead";
import "./trend-pieces.css";

// Same faces as the hero above (identical options share the font files).
const syne = Syne({ subsets: ["latin"], weight: ["700", "800"], variable: "--ts-font-latin" });
const interTight = Inter_Tight({ subsets: ["latin"], weight: ["600", "900"], variable: "--tp-font-display" });
const plex = IBM_Plex_Sans_Arabic({ subsets: ["arabic"], weight: ["400", "500", "600", "700"], variable: "--ts-font-ar" });

// "Trending pieces" grid under the /trending hero, after the catalogue grid
// in REF/20261024-2215-31.2252396.mp4: tall white cards in one row, name and
// a second line under each. Hovering a card turns its picture like a cube
// (the shown face folds to one edge while the next unfolds from the other,
// ~0.4 s) and swaps the text row for the card's options. With more than one
// extra view, the card keeps turning through them while the pointer stays.
//
// These pieces are not in Via's catalogue yet, so no prices or sizes are
// shown; each card opens its real section.

type Box = [number, number, number, number]; // x, y, w, h in source pixels

/** One picture of a piece. cut = cut-out on the white card; photo = fills the
 *  card; inset = square photo framed in the card; crop = close-up from the
 *  piece's main file. cap = largest scale over the file's own pixels (the
 *  small extra views are never blown up past 2x). */
type Face =
  | { mode: "cut" | "photo" | "inset"; file: string; w: number; h: number; alt: string; cap?: number }
  | { mode: "crop"; box: Box; alt: string };

type Piece = {
  file: string;
  w: number;
  h: number;
  name: string;
  section: string;
  href: string;
  color: string;
  swatch: string;
  faces: Face[]; // faces[0] is the card's main picture (file / w / h above)
};

const PIECES: Piece[] = [
  {
    file: "leather-wine", w: 605, h: 726,
    name: "جاكيت جلد بياقة", section: "قسم النساء", href: "/women",
    color: "عنابي", swatch: "#6A1F27",
    faces: [
      { mode: "cut", file: "leather-wine", w: 605, h: 726, alt: "جاكيت جلد عنابي بياقة وسحّاب معدني" },
      { mode: "cut", file: "leather-wine-angle", w: 986, h: 1091, alt: "الجاكيت من زاوية جانبية" },
      { mode: "crop", box: [100, 0, 400, 571], alt: "تفاصيل الياقة والسحّاب" },
    ],
  },
  {
    file: "knit-grey", w: 807, h: 950,
    name: "كنزة صوف بسحّاب نصفي", section: "قسم الرجال", href: "/discovery?segment=men",
    color: "رمادي", swatch: "#8B8580",
    faces: [
      { mode: "cut", file: "knit-grey", w: 807, h: 950, alt: "كنزة صوف رمادية مضلّعة بسحّاب نصفي، مطويّة" },
      { mode: "cut", file: "knit-grey-back", w: 1098, h: 1068, alt: "الكنزة من الخلف" },
      { mode: "crop", box: [150, 0, 420, 600], alt: "تفاصيل الياقة المضلّعة والسحّاب" },
    ],
  },
  {
    file: "cardigan-wine", w: 677, h: 796,
    name: "كارديغان مضلّع بأزرار", section: "قسم النساء", href: "/women",
    color: "خمري", swatch: "#3F1219",
    faces: [
      { mode: "cut", file: "cardigan-wine", w: 677, h: 796, alt: "كارديغان خمري قصير بأكمام منفوخة وخصر مضلّع" },
      { mode: "cut", file: "cardigan-wine-side", w: 245, h: 392, cap: 2, alt: "الكارديغان من الجانب" },
      { mode: "inset", file: "cardigan-wine-buttons", w: 316, h: 323, cap: 2, alt: "الأزرار المعدنية والخصر المضلّع عن قرب" },
    ],
  },
  {
    file: "puffer-black", w: 666, h: 829,
    name: "جاكيت منفوخ قصير", section: "قسم الرجال", href: "/discovery?segment=men",
    color: "أسود", swatch: "#161616",
    faces: [
      { mode: "cut", file: "puffer-black", w: 666, h: 829, alt: "جاكيت منفوخ أسود قصير بياقة عالية وسحّاب" },
      { mode: "cut", file: "puffer-black-back", w: 168, h: 151, cap: 2, alt: "الجاكيت من الخلف" },
      { mode: "crop", box: [140, 0, 400, 571], alt: "تفاصيل الياقة والتبطين" },
    ],
  },
  {
    file: "kids-stripe", w: 716, h: 856,
    name: "كنزة مخططة بسحّاب", section: "قسم الأطفال", href: "/discovery?segment=kids",
    color: "زيتي", swatch: "#6B7059",
    faces: [
      { mode: "photo", file: "kids-stripe", w: 716, h: 856, alt: "كنزة أطفال زيتية مخططة بالأبيض بسحّاب نصفي" },
      { mode: "crop", box: [190, 80, 420, 600], alt: "تفاصيل السحّاب والخطوط" },
    ],
  },
];

const url = (file: string) => `/trend/pieces/${file}`;
const TURN_EVERY = 1500; // ms between turns while the pointer stays (0.42 s turn + hold)

/** Background crop of the piece's main file for a close-up face. */
const cropStyle = (p: Piece, [x, y, w, h]: Box): React.CSSProperties => ({
  backgroundImage: `url("${url(p.file)}.webp")`,
  backgroundSize: `${(p.w / w) * 100}% auto`,
  backgroundPosition: `${(x / (p.w - w)) * 100}% ${(y / (p.h - h)) * 100}%`,
});

function FaceView({ piece, face, main }: { piece: Piece; face: Face; main: boolean }) {
  if (face.mode === "crop") return <span className="tp-crop" style={cropStyle(piece, face.box)} role="img" aria-label={face.alt} />;
  const capped = face.cap ? { maxWidth: face.w * face.cap, maxHeight: face.h * face.cap } : undefined;
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={`${url(face.file)}.webp`}
      srcSet={main ? `${url(face.file)}-half.webp ${Math.round(face.w / 2)}w, ${url(face.file)}.webp ${face.w}w` : undefined}
      sizes={main ? "(max-width: 767px) 46vw, (max-width: 1099px) 31vw, 19vw" : undefined}
      width={face.w}
      height={face.h}
      alt={face.alt}
      style={capped}
      loading="lazy"
      decoding="async"
      draggable={false}
    />
  );
}

function PieceCard({ piece, index }: { piece: Piece; index: number }) {
  const [view, setView] = useState({ on: 0, off: -1 });
  const timer = useRef(0);
  const n = piece.faces.length;

  const turnTo = (to: number) => setView((v) => (v.on === to ? v : { on: to, off: v.on }));
  const start = () => {
    window.clearInterval(timer.current);
    turnTo(1);
    if (n > 2 && !window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      // Keep turning through the extra views (1..n-1) while hovered.
      timer.current = window.setInterval(() => {
        setView((v) => {
          const to = v.on >= n - 1 ? 1 : v.on + 1;
          return { on: to, off: v.on };
        });
      }, TURN_EVERY);
    }
  };
  const stop = () => {
    window.clearInterval(timer.current);
    turnTo(0);
  };
  useEffect(() => () => window.clearInterval(timer.current), []);

  // Touch screens have no hover: there each card turns through all its
  // pictures on its own while it is on screen (staggered per card).
  const cardRef = useRef<HTMLAnchorElement>(null);
  useEffect(() => {
    const el = cardRef.current;
    if (!el || !window.matchMedia("(hover: none)").matches) return;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    let auto = 0;
    let delay = 0;
    const io = new IntersectionObserver(([e]) => {
      window.clearTimeout(delay);
      window.clearInterval(auto);
      if (!e.isIntersecting) return;
      delay = window.setTimeout(() => {
        auto = window.setInterval(() => setView((v) => ({ on: (v.on + 1) % n, off: v.on })), 2600);
      }, 900 + index * 450);
    }, { threshold: 0.6 });
    io.observe(el);
    return () => {
      io.disconnect();
      window.clearTimeout(delay);
      window.clearInterval(auto);
    };
  }, [index, n]);

  return (
    <li className="tp-item" style={{ "--i": index } as React.CSSProperties}>
      <Link
        ref={cardRef}
        href={piece.href}
        className="tp-card"
        data-turned={view.on !== 0 ? "" : undefined}
        aria-label={`${piece.name} - ${piece.color}، ${piece.section}`}
        onPointerEnter={(e) => e.pointerType === "mouse" && start()}
        onPointerLeave={(e) => e.pointerType === "mouse" && stop()}
        onFocus={(e) => e.currentTarget.matches(":focus-visible") && start()}
        onBlur={stop}
      >
        <span className={`tp-media${piece.faces[0].mode === "photo" ? " is-photo" : ""}`}>
          {piece.faces.map((f, i) => (
            <span
              key={i}
              className={`tp-face is-${f.mode}${i === view.on ? " is-on" : i === view.off ? " is-off" : ""}`}
              aria-hidden={i !== 0 || undefined}
            >
              <FaceView piece={piece} face={f} main={i === 0} />
            </span>
          ))}
          <span className="tp-ticks" aria-hidden="true">
            {piece.faces.map((_, i) => <i key={i} data-on={i === view.on ? "" : undefined} />)}
          </span>
        </span>
        <span className="tp-info">
          <span className="tp-row tp-row-main">
            <b className="tp-name">{piece.name}</b>
            <span className="tp-meta">{piece.section} · {n === 2 ? "صورتان" : `${n} صور`}</span>
          </span>
          <span className="tp-row tp-row-alt" aria-hidden="true">
            <span className="tp-chip">تسوّق</span>
            <span className="tp-swatch"><i style={{ background: piece.swatch }} />{piece.color}</span>
          </span>
        </span>
      </Link>
    </li>
  );
}

export default function TrendPieces() {
  const ref = useRef<HTMLElement>(null);

  // Cards rise in once, as the section comes up under the hero.
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      el.dataset.in = "";
      return;
    }
    const io = new IntersectionObserver(([e]) => {
      if (e.isIntersecting) {
        el.dataset.in = "";
        io.disconnect();
      }
    }, { threshold: 0.15 });
    io.observe(el);
    return () => io.disconnect();
  }, []);

  // The page header and the floating language switch are fixed over the
  // hero. Now that the page scrolls on into this grid, they leave the way
  // they do on the home page (glide up and fade as the hero ends), driven by
  // the same --via-home-header-scroll variable, so they never sit on cards.
  useEffect(() => {
    const header = document.querySelector<HTMLElement>(".trend-page-header");
    const lang = document.querySelector<HTMLElement>(".app-main.trend-main ~ .app-footer");
    const hero = document.querySelector<HTMLElement>(".ts-hero");
    let frame = 0;
    const update = () => {
      frame = 0;
      const heroEnd = hero ? hero.getBoundingClientRect().top + window.scrollY + hero.offsetHeight : window.innerHeight;
      const fadeStart = heroEnd - Math.min(340, hero ? hero.offsetHeight * 0.34 : 340);
      const progress = Math.min(Math.max((window.scrollY - fadeStart) / 230, 0), 1);
      for (const node of [header, lang]) {
        if (!node) continue;
        node.style.pointerEvents = progress >= 1 ? "none" : "";
        node.style.visibility = progress >= 1 ? "hidden" : "";
      }
      header?.style.setProperty("--via-home-header-scroll", String(progress));
      if (lang) lang.style.opacity = String(1 - progress);
    };
    const onScroll = () => {
      if (!frame) frame = requestAnimationFrame(update);
    };
    update();
    window.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("resize", onScroll);
    return () => {
      window.removeEventListener("scroll", onScroll);
      window.removeEventListener("resize", onScroll);
      cancelAnimationFrame(frame);
      for (const node of [header, lang]) node?.style.removeProperty("pointer-events");
      for (const node of [header, lang]) node?.style.removeProperty("visibility");
      header?.style.removeProperty("--via-home-header-scroll");
      lang?.style.removeProperty("opacity");
    };
  }, []);


  return (
    <section ref={ref} className={`tp ${syne.variable} ${plex.variable} ${interTight.variable}`} aria-labelledby="tp-title">
      {/* Editorial opening (after the "MOVEMENTS" layout): one oversized,
          tightly set headline with small labels placed around it. Each line
          sits in a mask and slides up once when the section scrolls in. */}
      <TrendEditorialHead
        id="tp-title"
        words={["TRENDING", "PIECES"]}
        label="Trending pieces - مختارات الموسم"
        arTitle="مختارات الموسم"
        count={PIECES.length}
        link={{ href: "/discovery", label: "تصفّح الكل" }}
      />

      <ul className="tp-grid">
        {PIECES.map((p, i) => <PieceCard key={p.file} piece={p} index={i} />)}
      </ul>
    </section>
  );
}
