"use client";

import { IBM_Plex_Sans_Arabic, Syne } from "next/font/google";
import Link from "next/link";
import gsap from "gsap";
import { useCallback, useEffect, useRef, useState } from "react";
import "./trend-chrome.css";
import "./trend-stage.css";

// /trending hero, rebuilt from the Jordan reference in REF/ (frame-by-frame).
// The reference is one long horizontal "camera track": the same model in
// several poses at different depths. Each scene is a camera stop; between
// stops every layer travels the same way at its own speed (huge foreground
// pose fastest, small full-body pose slower, background word slowest), and
// the side panels ride along. The loop from the last stop to the first keeps
// travelling the same way. Mirrored for the RTL page (travel left -> right).
//
// Timing measured from the reference (frame-difference analysis at 20 fps):
//   hold scene 1 ~1.3 s | transition 1->2 2.3 s (peak at ~48 %)
//   hold scene 2 ~1.4 s | transition 2->3 3.0 s (peak at ~43 %)
//   hold scene 3 >=0.8 s visible before the recording ends (1.4 s used)
//   transition 3->1: only its last 0.85 s is recorded -> 2.6 s (estimate).

const syne = Syne({ subsets: ["latin"], weight: ["700", "800"], variable: "--ts-font-latin" });
const plex = IBM_Plex_Sans_Arabic({ subsets: ["arabic"], weight: ["400", "500", "600", "700"], variable: "--ts-font-ar" });

export const TIMING = {
  hold: [1.3, 1.4, 1.4],      // seconds each scene stays still
  move: [2.3, 3.0, 2.6],      // seconds for scene i -> i+1 (last = loop to the first)
  ease: "power2.inOut",
};

// The four approved poses (same model, one outfit). w/h = native pixels.
const POSES = {
  A: { src: "/trend/pose/p13", w: 625, h: 1582, alt: "عارضة بطقم خمري تنظر إلى الأسفل وتمسك طرف الهودي" },
  B: { src: "/trend/pose/p14", w: 303, h: 970, alt: "عارضة بطقم خمري ويداها في الجيوب" },
  C: { src: "/trend/pose/p12", w: 475, h: 1582, alt: "عارضة بطقم خمري بوضعية جانبية" },
  D: { src: "/trend/pose/p11", w: 546, h: 1585, alt: "عارضة بطقم خمري بوضعية أمامية" },
} as const;
type PoseKey = keyof typeof POSES;
const KEYS: PoseKey[] = ["A", "B", "C", "D"];

// Frames in the reference's own LTR coordinates (fractions of the stage):
// [centre x, top, height]. "L" = gone past the exit edge, "R" = waiting
// beyond the entry edge. On screen no pose starts above the header nav.
type Frame = [number, number, number] | "L" | "R";
type Scene = Record<PoseKey, Frame>;
const DESKTOP: Scene[] = [
  { A: [0.315, 0.12, 1.34], B: [0.87, 0.2, 0.74], C: "R", D: "L" },
  { A: "L", B: [0.4, 0.2, 0.76], C: [0.12, -0.06, 1.65], D: "R" },
  // Closing shot: main front pose further right, the second pose smaller
  // toward the middle, the far left kept free for the copy.
  { A: [0.55, 0.12, 0.78], B: "L", C: "L", D: [0.24, 0.12, 1.4] },
];
const STACKED: Scene[] = [
  { A: [0.36, 0.03, 1.22], B: [0.86, 0.2, 0.78], C: "R", D: "L" },
  { A: "L", B: [0.7, 0.2, 0.8], C: [0.22, -0.04, 1.5], D: "R" },
  { A: [0.85, 0.12, 0.84], B: "L", C: "L", D: [0.36, 0.03, 1.28] },
];
const OFF_H: Record<PoseKey, number> = { A: 1.2, B: 0.76, C: 1.65, D: 1.3 };
const N = 3;
const STACKED_BELOW = 1100;
const HOVER_ZONES = ".ts-panel, .ts-bar, .ts-arrows";

// Scene 2 look crops, taken from the front pose (p11, 546x1585) and never
// the face. box = [x, y, w, h] in source pixels; thumb = a square crop
// (none = the whole figure fitted in the square).
type Box = [number, number, number, number];
const VIEW_SRC = `${POSES.D.src}.webp`;
const VIEWS: { label: string; thumb: Box | null; box: Box }[] = [
  { label: "الطقم كاملاً", thumb: null, box: [0, 0, 546, 1585] },
  { label: "الجزء العلوي", thumb: [3, 225, 540, 540], box: [0, 205, 546, 600] },
  { label: "البنطال", thumb: [0, 870, 546, 546], box: [0, 790, 546, 795] },
];
/** Background-image crop of the front pose; the viewer also gets its ratio and
 *  a height cap at the crop's own pixel height (no upscaling past the source). */
const cropStyle = ([x, y, w, h]: Box, viewer = false) => {
  const W = POSES.D.w;
  const H = POSES.D.h;
  return {
    backgroundImage: `url("${VIEW_SRC}")`,
    backgroundSize: `${(W / w) * 100}% auto`,
    backgroundPosition: `${w === W ? 50 : (x / (W - w)) * 100}% ${h === H ? 50 : (y / (H - h)) * 100}%`,
    ...(viewer ? { "--ar": `${w} / ${h}`, "--h": `${h}px` } : {}),
  } as React.CSSProperties;
};
const wrap = (i: number) => ((i % N) + N) % N;
const isStacked = () => window.innerWidth < STACKED_BELOW;
const framesFor = (s: number) => (isStacked() ? STACKED : DESKTOP)[s];

export default function TrendStage() {
  const [scene, setScene] = useState(0);
  const [playing, setPlaying] = useState(true);
  const [ready, setReady] = useState(false);
  const [announce, setAnnounce] = useState(false);
  const rootRef = useRef<HTMLElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const wordRef = useRef<HTMLDivElement>(null);
  const figRefs = useRef<Partial<Record<PoseKey, HTMLDivElement | null>>>({});
  const panelRefs = useRef<(HTMLDivElement | null)[]>([]);
  const barRef = useRef<HTMLSpanElement>(null);
  const goRef = useRef<(dir: 1 | -1, user: boolean) => void>(() => {});

  // Imperative motion state (never drives React renders on its own).
  const m = useRef({
    scene: 0,
    tl: null as gsap.core.Timeline | null,
    hold: null as gsap.core.Tween | null,
    pending: 0 as -1 | 0 | 1,
    playing: true,
    reasons: new Set<string>(),
    reduced: false,
    wordUnit: 0,
    insetTop: 0,
  });

  // ------------------------------------------------------------ geometry

  /** Transform for one pose in one frame (RTL-mirrored, px, origin top-left). */
  const xform = useCallback((key: PoseKey, f: Frame, edge?: "L" | "R") => {
    const stage = stageRef.current!;
    const W = stage.clientWidth;
    const H = stage.clientHeight;
    const pose = POSES[key];
    const which = edge ?? (typeof f === "string" ? f : null);
    const [cx, top, h] = which === "L" ? [-0.5, 0.1, OFF_H[key]] : which === "R" ? [1.5, 0.1, OFF_H[key]] : (f as [number, number, number]);
    const baseW = (H * pose.w) / pose.h;          // element box at scale 1 = full stage height
    const w = baseW * h;
    const x = (1 - cx) * W - w / 2;                 // mirror the LTR reference for RTL
    let y = top * H;
    if (which === null) y = Math.max(y, m.current.insetTop);
    return { x, y, scale: h };
  }, []);

  const sizeBoxes = useCallback(() => {
    const stage = stageRef.current;
    if (!stage) return;
    const H = stage.clientHeight;
    for (const key of KEYS) {
      const el = figRefs.current[key];
      if (!el) continue;
      el.style.height = `${H}px`;
      el.style.width = `${(H * POSES[key].w) / POSES[key].h}px`;
    }
    // Site header (fixed, over the hero): keep heads below its nav pill.
    const nav = document.querySelector(".trend-page-header nav");
    const top = stage.getBoundingClientRect().top;
    m.current.insetTop = nav && !isStacked() ? nav.getBoundingClientRect().bottom - top + 14 : 0;
    // Background word: one unit = "VIA WINTER ·" (the text repeats).
    const unit = wordRef.current?.querySelector<HTMLElement>(".ts-word-unit");
    m.current.wordUnit = unit ? unit.offsetWidth : 0;
  }, []);

  const wordX = (s: number) => {
    // Travels one third of a unit per scene; three scenes = one whole unit,
    // so the loop lands on an identical position.
    const u = m.current.wordUnit;
    return -u + (u / 3) * s;
  };

  const place = useCallback((s: number) => {
    const f = framesFor(s);
    for (const key of KEYS) {
      const el = figRefs.current[key];
      if (!el) continue;
      const t = xform(key, f[key]);
      gsap.set(el, { x: t.x, y: t.y, scale: t.scale, autoAlpha: typeof f[key] === "string" ? 0 : 1 });
    }
    panelRefs.current.forEach((p, i) => p && gsap.set(p, { x: 0, autoAlpha: i === s ? 1 : 0 }));
    if (wordRef.current) gsap.set(wordRef.current, { x: wordX(s) });
  }, [xform]);

  // ------------------------------------------------------- the transition
  /** Forward timeline from scene s to s+1 (paused). */
  const buildForward = useCallback((s: number) => {
    const to = wrap(s + 1);
    const D = TIMING.move[s];
    const tl = gsap.timeline({ paused: true, defaults: { ease: TIMING.ease } });
    const a = framesFor(s);
    const b = framesFor(to);
    const W = stageRef.current!.clientWidth;

    if (m.current.reduced) {
      const els = [...KEYS.map((k) => figRefs.current[k]), ...panelRefs.current];
      tl.to(els, { autoAlpha: 0, duration: 0.25 }, 0)
        .call(() => place(to), undefined, 0.25)
        .to([...KEYS.filter((k) => typeof b[k] !== "string").map((k) => figRefs.current[k]), panelRefs.current[to]], { autoAlpha: 1, duration: 0.25 }, 0.26);
      return tl;
    }

    for (const key of KEYS) {
      const el = figRefs.current[key];
      if (!el) continue;
      const fa = a[key];
      const fb = b[key];
      if (typeof fa === "string" && fa === fb) continue;               // stays off-frame
      if (fa === "L" && fb !== "L") {
        // Gone out of the exit side: wraps round to wait at the entry side.
        tl.set(el, { ...xform(key, fa, "R"), autoAlpha: 1 }, 0);
      }
      const t = xform(key, fb);
      tl.to(el, { x: t.x, y: t.y, scale: t.scale, duration: D }, 0);
      if (fb === "L") tl.set(el, { autoAlpha: 0 }, D);
      if (fa !== "L" && typeof fa === "string") tl.set(el, { autoAlpha: 1 }, 0);
    }

    // Panels ride the track at the mid layer's pace: out toward the exit
    // side (fading early so the copy never sits on a passing figure), the
    // next one in from the entry side.
    const travel = W * 0.62;
    tl.to(panelRefs.current[s], { x: travel * 0.5, autoAlpha: 0, duration: D * 0.45, ease: "power2.in" }, 0)
      .fromTo(panelRefs.current[to], { x: -travel, autoAlpha: 1 }, { x: 0, duration: D * 0.62, ease: "power2.out" }, D * 0.38);

    if (wordRef.current) {
      const end = s === N - 1 ? wordX(N) : wordX(to);
      tl.fromTo(wordRef.current, { x: wordX(s) }, { x: end, duration: D }, 0);
    }
    return tl;
  }, [place, xform]);

  // ------------------------------------------------------------ autoplay
  const canRun = () => m.current.playing && m.current.reasons.size === 0 && !m.current.reduced;

  const startHold = useCallback(() => {
    m.current.hold?.kill();
    const bar = barRef.current;
    if (bar) gsap.set(bar, { scaleX: 0 });
    if (!m.current.playing || m.current.reduced) return;
    m.current.hold = gsap.to(bar ?? {}, {
      scaleX: 1,
      duration: TIMING.hold[m.current.scene],
      ease: "none",
      paused: !canRun(),
      onComplete: () => goRef.current(1, false),
    });
  }, []);

  const go = useCallback((dir: 1 | -1, user: boolean) => {
    const st = m.current;
    if (user) {
      setAnnounce(true);
      if (st.playing) {
        st.playing = false;
        setPlaying(false);
      }
    }
    if (st.tl && st.tl.isActive()) {
      // Rapid input: finish the running move quickly, then take this one.
      st.pending = dir;
      st.tl.timeScale(4);
      return;
    }
    st.hold?.kill();
    const from = st.scene;
    const to = wrap(from + dir);
    // Backward = the forward move from "to" played in reverse. Its tweens
    // record their start values on first render, so lay out "to" first and
    // render the end at once (identical to what is on screen): no flash.
    if (dir === -1) place(to);
    const tl = dir === 1 ? buildForward(from) : buildForward(to);
    st.tl = tl;
    st.scene = to;
    setScene(to);
    tl.eventCallback(dir === 1 ? "onComplete" : "onReverseComplete", () => {
      st.tl = null;
      place(to);
      const p = st.pending;
      st.pending = 0;
      if (p) goRef.current(p, false);
      else startHold();
    });
    if (dir === 1) tl.play(0);
    else tl.progress(1).reverse();
    if (st.reasons.has("offscreen") || st.reasons.has("hidden")) tl.pause();
  }, [buildForward, place, startHold]);
  useEffect(() => {
    goRef.current = go;
  }, [go]);

  // Pause reasons: hover, keyboard focus inside, off-screen, hidden tab.
  const pauseFor = useCallback((reason: string, on: boolean) => {
    const st = m.current;
    if (on) st.reasons.add(reason);
    else st.reasons.delete(reason);
    if (st.hold) {
      if (canRun()) st.hold.resume();
      else st.hold.pause();
    }
    // A move in progress finishes on hover/focus; it only freezes while the
    // hero is off-screen or the tab is hidden.
    const away = st.reasons.has("offscreen") || st.reasons.has("hidden");
    if (st.tl) {
      if (away) st.tl.pause();
      else if (st.tl.paused()) st.tl.resume();
    }
  }, []);

  const togglePlay = () => {
    const st = m.current;
    st.playing = !st.playing;
    setPlaying(st.playing);
    setAnnounce(false);
    if (st.playing) startHold();
    else st.hold?.kill();
  };

  // --------------------------------------------------------------- setup
  useEffect(() => {
    const st = m.current;
    const root = rootRef.current;
    const stage = stageRef.current;
    if (!root || !stage) return;
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    st.reduced = mq.matches;
    if (st.reduced) {
      st.playing = false;
      setPlaying(false);
    }
    let disposed = false;

    sizeBoxes();
    place(st.scene);

    // Start only once the first scene's images are decoded (no blank frame).
    const first = KEYS.filter((k) => typeof framesFor(st.scene)[k] !== "string")
      .map((k) => figRefs.current[k]?.querySelector("img"))
      .filter((i): i is HTMLImageElement => !!i);
    Promise.all(first.map((i) => (i.complete ? Promise.resolve() : i.decode().catch(() => undefined)))).then(() => {
      if (disposed) return;
      setReady(true);
      startHold();
    });

    const onMotion = () => {
      st.reduced = mq.matches;
      if (st.reduced) {
        st.playing = false;
        setPlaying(false);
        st.hold?.kill();
      }
    };
    mq.addEventListener("change", onMotion);

    let raf = 0;
    const ro = new ResizeObserver(() => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        if (st.tl?.isActive()) st.tl.progress(st.tl.reversed() ? 0 : 1);
        sizeBoxes();
        place(st.scene);
      });
    });
    ro.observe(stage);

    const io = new IntersectionObserver(([e]) => pauseFor("offscreen", !e.isIntersecting), { threshold: 0.25 });
    io.observe(root);
    const onVis = () => pauseFor("hidden", document.hidden);
    document.addEventListener("visibilitychange", onVis);

    return () => {
      disposed = true;
      mq.removeEventListener("change", onMotion);
      ro.disconnect();
      io.disconnect();
      document.removeEventListener("visibilitychange", onVis);
      cancelAnimationFrame(raf);
      st.hold?.kill();
      st.tl?.kill();
    };
  }, [place, sizeBoxes, startHold, pauseFor]);

  // Touch swipe (RTL: the track travels rightward on "next").
  const swipe = useRef<{ x: number; y: number; id: number } | null>(null);

  // Look crops: selecting one opens it in the viewer; the hero waits meanwhile.
  const [view, setView] = useState(0);
  const viewerRef = useRef<HTMLDialogElement>(null);
  const openView = (i: number) => {
    setView(i);
    pauseFor("viewer", true);
    viewerRef.current?.showModal();
  };

  return (
    <section
      ref={rootRef}
      className={`ts-hero ${syne.variable} ${plex.variable}`}
      data-ready={ready ? "" : undefined}
      aria-roledescription="عرض متحرك"
      aria-label="ترند الشتاء: طقم خمري مريح"
      // The hero fills the viewport, so hovering it as a whole would pause it
      // almost always: pause while the pointer is on what people read or use.
      onPointerOver={(e) => e.pointerType === "mouse" && pauseFor("hover", !!(e.target as Element).closest(HOVER_ZONES))}
      onPointerLeave={(e) => e.pointerType === "mouse" && pauseFor("hover", false)}
      onFocus={(e) => e.target.matches(":focus-visible") && pauseFor("focus", true)}
      onBlur={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) pauseFor("focus", false);
      }}
      onKeyDown={(e) => {
        if ((e.target as Element).closest(".ts-viewer")) return;
        if (e.key === "ArrowLeft") { e.preventDefault(); go(1, true); }       // RTL: left = next
        else if (e.key === "ArrowRight") { e.preventDefault(); go(-1, true); }
      }}
      onPointerDown={(e) => {
        if (e.pointerType !== "mouse") swipe.current = { x: e.clientX, y: e.clientY, id: e.pointerId };
      }}
      onPointerUp={(e) => {
        const s = swipe.current;
        swipe.current = null;
        if (!s || s.id !== e.pointerId) return;
        const dx = e.clientX - s.x;
        if (Math.abs(dx) > 50 && Math.abs(dx) > Math.abs(e.clientY - s.y) * 1.3) go(dx > 0 ? 1 : -1, true);
      }}
    >
      {/* Background word (travels slowest; repeats so the loop is seamless) */}
      <div className="ts-word" ref={wordRef} aria-hidden="true">
        {[0, 1, 2, 3].map((i) => <span key={i} className="ts-word-unit">VIA WINTER ·&nbsp;</span>)}
      </div>

      {/* The camera track */}
      <div className="ts-stage" ref={stageRef}>
        {KEYS.map((key) => {
          const p = POSES[key];
          return (
            <div key={key} ref={(el) => { figRefs.current[key] = el; }} className="ts-figure">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={`${p.src}.webp`}
                srcSet={`${p.src}-half.webp ${Math.round(p.w / 2)}w, ${p.src}.webp ${p.w}w`}
                sizes="(max-width: 767px) 50vw, 60vw"
                width={p.w}
                height={p.h}
                alt={p.alt}
                draggable={false}
                fetchPriority={key === "A" ? "high" : "auto"}
              />
            </div>
          );
        })}
      </div>

      {/* Panels that ride the track */}
      <div className="ts-panels" aria-live={announce ? "polite" : "off"}>
        <div ref={(el) => { panelRefs.current[0] = el; }} className="ts-panel ts-panel-notes" inert={scene !== 0} aria-hidden={scene !== 0}>
          <h2 className="ts-heading"><span aria-hidden="true" />لماذا هذا الطقم؟</h2>
          <ul className="ts-notes">
            <li><b>هودي واسع بسحّاب نصفي</b><span>قصّة مريحة بأكمام منسدلة وجيب أمامي.</span></li>
            <li><b>بنطلون واسع بنفس اللون</b><span>طقم خمري متناسق من الرأس للقدم.</span></li>
            <li><b>دفء لأيام الشتاء</b><span>إطلالة مريحة للبيت والمشاوير اليومية.</span></li>
          </ul>
          <span className="ts-count">01 / 03</span>
        </div>

        <div ref={(el) => { panelRefs.current[1] = el; }} className="ts-panel ts-panel-details" inert={scene !== 1} aria-hidden={scene !== 1}>
          <span className="ts-eyebrow">تشكيلة الشتاء</span>
          <h2 className="ts-details-title">الطقم الخمري</h2>
          <p className="ts-details-text">سويت شيرت بسحّاب نصفي وبنطال بقَصّة واسعة</p>
          {/* No product record exists for this set yet, so no sizes or stock
              are shown; the link goes to the existing women's collection. */}
          <div className="ts-thumbs" role="group" aria-label="صور الطقم">
            {VIEWS.map((v, i) => (
              <div key={v.label}>
                <button
                  type="button"
                  className="ts-thumb"
                  aria-label={`عرض صورة: ${v.label}`}
                  aria-pressed={view === i}
                  onClick={() => openView(i)}
                  style={v.thumb ? cropStyle(v.thumb) : { backgroundImage: `url("${VIEW_SRC}")`, backgroundSize: "auto 94%", backgroundPosition: "50% 100%" }}
                />
                <span className="ts-thumb-label" aria-hidden="true">{v.label}</span>
              </div>
            ))}
          </div>
          <Link href="/women" className="ts-wide-cta">تصفّحي مجموعة النساء</Link>
        </div>

        <div ref={(el) => { panelRefs.current[2] = el; }} className="ts-panel ts-panel-title" inert={scene !== 2} aria-hidden={scene !== 2}>
          <h1 className="ts-title"><span>الشتا</span><span>على طريقتك</span></h1>
          <p className="ts-sub">الطقم الخمري، بطريقتك.</p>
          <Link href="/women" className="ts-collection-cta">
            اكتشفي المجموعة
            <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M19 12H5M10 7l-5 5 5 5" /></svg>
          </Link>
        </div>
      </div>

      <dialog
        ref={viewerRef}
        className="ts-viewer"
        aria-label={VIEWS[view].label}
        onClose={() => pauseFor("viewer", false)}
        onClick={(e) => e.target === e.currentTarget && e.currentTarget.close()}
      >
        <div className="ts-viewer-head">
          <b>{VIEWS[view].label}</b>
          <button type="button" className="ts-viewer-close" aria-label="إغلاق" onClick={() => viewerRef.current?.close()}>
            <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18" /></svg>
          </button>
        </div>
        <div className="ts-viewer-img" role="img" aria-label={`الطقم الخمري: ${VIEWS[view].label}`} style={cropStyle(VIEWS[view].box, true)} />
      </dialog>

      {/* Bottom bar: shown colour + progress + play/pause */}
      <div className="ts-bar">
        <span className="ts-bar-label">اللون المعروض: <b>خمري</b></span>
        <span className="ts-bar-track" aria-hidden="true"><span className="ts-bar-fill" ref={barRef} /></span>
        <button
          type="button"
          className="ts-play"
          onClick={togglePlay}
          aria-pressed={!playing}
          aria-label={playing ? "إيقاف العرض التلقائي" : "تشغيل العرض التلقائي"}
        >
          {playing ? (
            <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5v14M16 5v14" /></svg>
          ) : (
            <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5.5v13l10-6.5z" /></svg>
          )}
          <span>{playing ? "إيقاف" : "تشغيل"}</span>
        </button>
      </div>

      <div className="ts-arrows">
        <button type="button" className="ts-arrow" aria-label="اللقطة التالية" onClick={() => go(1, true)}>
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m15 6-6 6 6 6" /></svg>
        </button>
        <button type="button" className="ts-arrow" aria-label="اللقطة السابقة" onClick={() => go(-1, true)}>
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m9 6 6 6-6 6" /></svg>
        </button>
      </div>

      <p className="ts-sr" aria-live="polite">{announce ? `اللقطة ${scene + 1} من ${N}` : ""}</p>
    </section>
  );
}
