// =========================================================================
// Trend hero engine (ported from the standalone trend-hero/main.js).
// mountTrendHero(root) wires everything inside `root` and returns a
// destroy() that removes every listener, tween, timer and GPU resource,
// so the hero mounts/unmounts cleanly with client-side navigation.
//
// One loop (gsap.ticker → a single requestAnimationFrame) drives the
// camera, the parallax, the cards and the WebGL frame. Everything the UI
// shows is generated from LOOKS; every number worth tuning is in TUNE.
// =========================================================================
import gsap from "gsap";
import { GlitchRenderer } from "./glitch.js";

// -------------------------------------------------------------- TUNE
export const TUNE = {
  duration: 1.25,          // transition length (s)
  ease: "power3.inOut",
  glitch: 1,               // uIntensity: 0 = crossfade … 1 = full glitch (1.4 = wilder)
  slices: 26,              // number of horizontal slices
  shadow: 0.45,            // contact-shadow opacity (0 = off)
  wheelSpeed: 0.0011,      // camera travel per wheel pixel (camera runs 0 → 1, head → shoes)
  pushToNext: 0.35,        // extra scroll past the shoes/head (camera units) before switching look
  camEase: 0.085,          // camera smoothing per 60fps frame (higher = snappier)
  mouseParallax: 10,       // model follows the mouse by ±N px (at 1920 wide; scales up)
  nameParallax: 40,        // name/info rise by N px over the full camera travel
  cardsParallax: 30,       // cards rise by N px over the full camera travel
  bgWordParallax: 24,      // the faint background word rises by N px over the camera travel
  currency: "₪",           // shown after every price (no conversion - demo values)
  cooldown: 450,           // ms of ignored wheel/drag after a transition (trackpad inertia)
  xlThreshold: 2048,       // height of the md image; xl loads only when the model is drawn taller than
  xlTolerance: 1.08,       // … this many times md - a 1:1 md beats a 2× box-filtered xl (sharper at 1080p)
  // Framing per screen size. zoom = model height ÷ hero height.
  // top = where the image's top edge sits at the head (fraction of hero height).
  // bottom = where the image's bottom edge sits at the shoes.
  // x = horizontal centre of the model (fraction of width, 0 = left edge).
  framing: [
    // Desktop/laptop: the approved standalone values; on top of that the
    // head never starts above options.topInset() (the site header's bottom).
    // Mobile: lower, because the headline sits under the two-row site header.
    { name: "mobile", maxWidth: 767, zoom: 1.3, top: 0.35, bottom: 0.72, x: 0.5 },
    { name: "laptop", maxWidth: 1439, zoom: 1.75, top: 0.1, bottom: 0.98, x: 0.43 },
    { name: "desktop", maxWidth: Infinity, zoom: 1.9, top: 0.09, bottom: 0.98, x: 0.43 },
  ],
};

// -------------------------------------------------------------- DATA
// DEMO DATA. Product names and colours describe what each photo actually
// shows; prices (numbers, shown in ₪) and sizes are placeholders
// (demo: true) until the hero is wired to real Via products. No store
// data is included on purpose.
export const LOOKS = [
  {
    id: "burgundy-lounge", rank: 1, title: "أناقة بلا تكلّف", subtitle: "طقم خمري مريح · إطلالة الخريف",
    img: { md: "/trend/woman-2048.webp", xl: "/trend/woman-4096.webp" },
    accent: "#A8835A",
    shopHref: "/women",
    preview: { size: "200%", pos: "42% 2%" },
    products: [
      { title: "هودي خمري واسع بسحاب عند الرقبة", type: "هوديز", price: 149, sizes: ["XS", "S", "M", "L"], swatches: ["#4A2330"], demo: true },
      { title: "بنطلون رياضي خمري واسع", type: "بناطيل", price: 119, sizes: ["XS", "S", "M", "L"], swatches: ["#4A2330"], demo: true },
      { title: "حذاء رياضي كريمي", type: "أحذية", price: 189, sizes: ["37", "38", "39", "40", "41"], swatches: ["#E9E4DA"], demo: true },
    ],
  },
  {
    id: "grey-fleece", rank: 2, title: "أسلوبك، حضورك", subtitle: "رمادي هادئ · إطلالة يومية",
    img: { md: "/trend/man-2048.webp", xl: "/trend/man-4096.webp" },
    accent: "#6E7B58",
    shopHref: "/discovery",
    preview: { size: "200%", pos: "50% 3%" },
    products: [
      { title: "سويت شيرت رمادي برقبة دائرية", type: "سويت شيرت", price: 119, sizes: ["S", "M", "L", "XL"], swatches: ["#A9A9A6"], demo: true },
      { title: "بنطلون رياضي رمادي واسع", type: "بناطيل", price: 109, sizes: ["S", "M", "L", "XL"], swatches: ["#A9A9A6"], demo: true },
    ],
  },
];

const NAME_SLICES = 6;
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const lerp = (a, b, t) => a + (b - a) * t;

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

/**
 * Wires the hero inside `root` (the .th-hero element). Returns destroy().
 * options.topInset(): px from the hero's top that the model's head must
 * start below (e.g. the bottom of a fixed site header); measured on resize.
 */
export function mountTrendHero(root, options = {}) {
  const q = (id) => root.querySelector(`[data-th="${id}"]`);
  const reduced = window.matchMedia("(prefers-reduced-motion: reduce)");

  const dom = {
    hero: root,
    canvas: q("stage"),
    fallback: q("fallback"),
    loader: q("loader"),
    loaderFill: q("loaderFill"),
    loaderPct: q("loaderPct"),
    loaderBrand: q("loaderBrand"),
    nameWrap: q("nameWrap"),
    name: q("name"),
    nameLive: q("nameLive"),
    spacer: q("nameSpacer"),
    ghost: q("nameGhost"),
    slicesWrap: q("nameSlices"),
    info: q("info"),
    lineAr: q("lineAr"),
    badge: q("badge"),
    dots: q("dots"),
    prev: q("prevBtn"),
    next: q("nextBtn"),
    cta: q("cta"),
    controls: q("controls"),
    cards: q("cards"),
    cam: q("cam"),
    camDot: q("camDot"),
    camTrack: q("camTrack"),
    nextBox: q("nextBox"),
    nextMedia: q("nextMedia"),
    nextName: q("nextName"),
    bgWord: q("bgWord"),
    lookNum: q("lookNum"),
    lookTotal: q("lookTotal"),
    hint: q("hint"),
  };

  // -------------------------------------------------------------- state
  const state = {
    index: 0,
    cam: 0,
    camTarget: 0,
    push: 0,
    pushTimer: 0,
    mouse: { x: 0, y: 0, tx: 0, ty: 0 },
    locked: true,               // until loading finishes
    cooldownUntil: 0,
    trans: null,                // { from, to, p, zoom2, drift, oldCam, seed }
    vw: 0, vh: 0, dpr: 1, s: 1,
    frame: TUNE.framing[TUNE.framing.length - 1],
    cardBoxes: [],
    camTrackH: 0,
    topInset: 0,
    dirty: true,
    last: {},                   // last written DOM values (skip identical writes)
  };

  const images = [];            // decoded <img> per look
  const aspects = [];           // width / height per look
  const textures = new Map();   // look index → WebGLTexture (current, neighbours only)
  let renderer = null;
  let fallbackImgs = [];
  let hintHidden = false;
  let destroyed = false;
  let timeline = null;
  const cleanups = [];

  const multi = () => LOOKS.length > 1;
  const wrap = (i) => ((i % LOOKS.length) + LOOKS.length) % LOOKS.length;
  const listen = (target, type, fn, opts) => {
    target.addEventListener(type, fn, opts);
    cleanups.push(() => target.removeEventListener(type, fn, opts));
  };

  // ------------------------------------------------------------- loader
  function setProgress(pct) {
    const v = Math.round(clamp(pct, 0, 100));
    dom.loaderPct.textContent = String(v);
    dom.loaderFill.style.transform = `scaleX(${v / 100})`;
  }

  function heroSize() {
    return { w: root.clientWidth || window.innerWidth, h: root.clientHeight || window.innerHeight };
  }

  function pickVariant() {
    const { w, h } = heroSize();
    const frame = TUNE.framing.find((f) => w <= f.maxWidth);
    const displayed = h * frame.zoom * (window.devicePixelRatio || 1);
    return displayed > TUNE.xlThreshold * TUNE.xlTolerance ? "xl" : "md";
  }

  async function loadImage(src) {
    const img = new Image();
    img.decoding = "async";
    img.src = src;
    await img.decode();
    return img;
  }

  async function preload() {
    const variant = pickVariant();
    let done = 0;
    const step = () => { if (!destroyed) setProgress((++done / LOOKS.length) * 92); };
    const loaded = await Promise.all(
      LOOKS.map(async (look) => {
        let img;
        try {
          img = await loadImage(look.img[variant]);
        } catch {
          img = await loadImage(look.img[variant === "xl" ? "md" : "xl"]);
        }
        step();
        return img;
      }),
    );
    loaded.forEach((img, i) => {
      images[i] = img;
      aspects[i] = img.naturalWidth / img.naturalHeight;
    });
    // Fonts (next/font): never wait longer than 1.5 s.
    const fonts = document.fonts ? document.fonts.ready : Promise.resolve();
    await Promise.race([fonts, new Promise((r) => setTimeout(r, 1500))]);
    if (!destroyed) setProgress(100);
  }

  // ----------------------------------------------------------- textures
  function texture(i) {
    if (!renderer) return null;
    let tex = textures.get(i);
    if (!tex) {
      tex = renderer.createTexture(images[i]);
      textures.set(i, tex);
    }
    return tex;
  }

  // Keep only the current look and its neighbours on the GPU.
  function pruneTextures() {
    if (!renderer) return;
    const keep = new Set([state.index, wrap(state.index + 1), wrap(state.index - 1)]);
    for (const [i, tex] of textures) {
      if (!keep.has(i)) {
        renderer.deleteTexture(tex);
        textures.delete(i);
      }
    }
  }

  function warmNeighbours() {
    if (!renderer || !multi()) return;
    const run = () => {
      if (destroyed || state.locked || !renderer) return;
      texture(wrap(state.index + 1));
      if (LOOKS.length > 2) texture(wrap(state.index - 1));
    };
    if (window.requestIdleCallback) {
      const id = window.requestIdleCallback(run);
      cleanups.push(() => window.cancelIdleCallback?.(id));
    } else {
      const id = setTimeout(run, 120);
      cleanups.push(() => clearTimeout(id));
    }
  }

  // ----------------------------------------------------------- fallback
  function enterFallback() {
    renderer = null;
    textures.clear();
    dom.hero.classList.add("th-is-fallback");
    dom.fallback.replaceChildren();
    fallbackImgs = images.map((img, i) => {
      const node = el("img");
      node.src = img.src;
      node.alt = "";
      node.decoding = "async";
      node.style.opacity = i === state.index ? "1" : "0";
      dom.fallback.appendChild(node);
      return node;
    });
    sizeFallback();
    state.dirty = true;
  }

  function sizeFallback() {
    fallbackImgs.forEach((node, i) => {
      const h = state.vh * state.frame.zoom;
      node.style.width = `${h * aspects[i]}px`;
      node.style.height = `${h}px`;
    });
  }

  // ------------------------------------------------------------- layout
  function resize() {
    const { w: vw, h: vh } = heroSize();
    state.vw = vw;
    state.vh = vh;
    state.frame = TUNE.framing.find((f) => vw <= f.maxWidth);
    state.s = state.frame.name === "mobile" ? 1 : clamp(vw / 1920, 0.62, 2.2);
    // Full device resolution up to 2 (a lower cap blurred 4K at 200%). Cost
    // is bounded: only the model's rect is shaded and idle frames aren't drawn.
    state.dpr = Math.min(window.devicePixelRatio || 1, 2);
    if (renderer) renderer.setSize(Math.round(vw * state.dpr), Math.round(vh * state.dpr));
    if (fallbackImgs.length) sizeFallback();
    measureCards();
    state.camTrackH = dom.camTrack.clientHeight;
    state.topInset = state.frame.name === "mobile" ? 0 : Math.max(0, options.topInset?.() ?? 0);
    state.last = {};
    state.dirty = true;
  }

  function measureCards() {
    state.cardBoxes = Array.from(dom.cards.children, (card) => ({
      left: card.offsetLeft,
      width: card.offsetWidth,
    }));
  }

  /** Model rect in CSS px: [x, y, w, h]. scale grows about the rect's visible centre. */
  function figureRect(i, cam, scale = 1, dy = 0) {
    const { vw, vh, frame, s, mouse } = state;
    const h = vh * frame.zoom;
    const w = h * aspects[i];
    let x = frame.x * vw - w / 2 - mouse.x * TUNE.mouseParallax * s;
    const startY = Math.max(frame.top * vh, state.topInset);
    let y = lerp(startY, frame.bottom * vh - h, cam) - mouse.y * TUNE.mouseParallax * s + dy;
    if (scale !== 1) {
      const cx = x + w / 2;
      const cy = clamp(vh / 2, y, y + h);
      x = cx + (x - cx) * scale;
      y = cy + (y - cy) * scale;
    }
    return [x, y, w * scale, h * scale];
  }

  const toCanvas = (r) => r.map((v) => v * state.dpr);

  // ------------------------------------------------------------ content
  function makeCrop(look) {
    const crop = el("span", "th-crop");
    const conf = look.preview;
    const img = images[LOOKS.indexOf(look)];
    crop.style.backgroundImage = `url("${img.src}")`;
    crop.style.backgroundSize = `${conf.size} auto`;
    crop.style.backgroundPosition = conf.pos;
    return crop;
  }

  function setWords(target, text) {
    target.replaceChildren();
    // Arabic is split by words only - letters stay joined.
    text.split(/\s+/).forEach((word, i, all) => {
      const w = el("span", "th-w");
      w.appendChild(el("span", "", word));
      target.appendChild(w);
      if (i < all.length - 1) target.appendChild(document.createTextNode(" "));
    });
  }

  function setBadge(look) {
    dom.badge.replaceChildren(
      document.createTextNode("ترند "),
      el("b", "", `#${look.rank}`),
      document.createTextNode(" · الأكثر طلباً هالأسبوع"),
    );
  }

  function buildNameSlices(text) {
    dom.slicesWrap.replaceChildren();
    for (let i = 0; i < NAME_SLICES; i++) {
      const slice = el("span", "th-name-slice", text);
      const top = (i * 100) / NAME_SLICES - 0.4;
      const bottom = ((NAME_SLICES - 1 - i) * 100) / NAME_SLICES - 0.4;
      slice.style.clipPath = `inset(${Math.max(0, top)}% -2% ${Math.max(0, bottom)}% -2%)`;
      dom.slicesWrap.appendChild(slice);
    }
  }

  function setName(look) {
    dom.spacer.textContent = look.title;
    dom.ghost.textContent = look.title;
    buildNameSlices(look.title);
    dom.nameLive.textContent = `${look.subtitle} — ترند رقم ${look.rank}`;
  }

  /** "149 ₪" - number first, symbol after, inside an LTR run so RTL never reorders it. */
  function priceNode(value) {
    const node = el("span", "th-card-price");
    node.dir = "ltr";
    const amount = Number(value).toLocaleString("en-US", { maximumFractionDigits: 2 });
    node.setAttribute("aria-label", `${amount} شيكل`);
    node.append(el("span", "", amount), el("span", "th-card-currency", TUNE.currency));
    return node;
  }

  function renderCards(look) {
    dom.cards.replaceChildren(
      ...look.products.map((product, i) => {
        const card = el("article", "th-card");
        card.dataset.i = String(i);
        const inner = el("div", "th-card-inner");

        const head = el("div", "th-card-head");
        const titles = el("div");
        titles.append(el("span", "th-card-type", product.type), el("h2", "th-card-title", product.title));
        const plus = el("button", "th-card-plus");
        plus.type = "button";
        plus.setAttribute("aria-label", `أضف ${product.title} إلى السلة`);
        plus.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg>';
        head.append(titles, plus);

        const sizes = el("div", "th-card-sizes");
        sizes.setAttribute("aria-label", `المقاسات المتوفرة: ${product.sizes.join("، ")}`);
        product.sizes.forEach((size) => sizes.appendChild(el("span", "", size)));

        const foot = el("div", "th-card-foot");
        const swatches = el("span", "th-swatches");
        swatches.setAttribute("role", "img");
        swatches.setAttribute("aria-label", `${product.swatches.length} ألوان متوفرة`);
        product.swatches.forEach((color) => {
          const dot = el("span");
          dot.style.backgroundColor = color;
          swatches.appendChild(dot);
        });
        foot.append(priceNode(product.price), swatches);

        inner.append(head, sizes, foot);
        card.appendChild(inner);
        return card;
      }),
    );
    measureCards();
    state.last.cardOpacity = [];
    state.dirty = true;
  }

  function renderDots() {
    dom.dots.replaceChildren(
      ...LOOKS.map((look, i) => {
        const dot = el("button", "th-dot");
        dot.type = "button";
        dot.setAttribute("role", "tab");
        dot.setAttribute("aria-label", `الإطلالة ${i + 1}: ${look.subtitle}`);
        dot.setAttribute("aria-selected", String(i === state.index));
        dot.addEventListener("click", () => goTo(i));
        return dot;
      }),
    );
  }

  function selectDot(i) {
    Array.from(dom.dots.children).forEach((dot, j) => dot.setAttribute("aria-selected", String(j === i)));
  }

  function setLookIndex(i) {
    dom.lookNum.textContent = String(i + 1).padStart(2, "0");
    dom.lookTotal.textContent = String(LOOKS.length).padStart(2, "0");
  }

  function applyLook(i) {
    const look = LOOKS[i];
    setLookIndex(i);
    root.style.setProperty("--th-accent", look.accent);
    setName(look);
    setWords(dom.lineAr, look.subtitle);
    setBadge(look);
    dom.cta.setAttribute("href", look.shopHref);
    const next = LOOKS[wrap(i + 1)];
    dom.nextMedia.replaceChildren(makeCrop(next));
    dom.nextName.textContent = next.title;
    renderCards(look);
    selectDot(i);
  }

  // --------------------------------------------------------- transition
  function swapCrop(container, look) {
    const crop = makeCrop(look);
    crop.classList.add("th-is-anim");
    container.appendChild(crop);
    gsap.fromTo(
      crop,
      { clipPath: "inset(100% 0% 0% 0%)", scale: 1.18 },
      {
        clipPath: "inset(0% 0% 0% 0%)",
        scale: 1,
        duration: 0.8,
        ease: "power3.inOut",
        onComplete: () => {
          Array.from(container.children).forEach((child) => child !== crop && child.remove());
          gsap.set(crop, { clearProps: "transform,clipPath" });
          crop.classList.remove("th-is-anim");
        },
      },
    );
  }

  function nameTimeline(tl, look, D) {
    const text = look.title;
    if (reduced.matches) {
      tl.to(dom.name, { opacity: 0, duration: D * 0.4, ease: "power1.in" }, 0)
        .call(() => setName(look), null, D * 0.42)
        .to(dom.name, { opacity: 1, duration: D * 0.5, ease: "power1.out" }, D * 0.45);
      return;
    }
    const vw = state.vw;
    const slices = Array.from(dom.slicesWrap.children);
    dom.ghost.textContent = text;

    slices.forEach((slice) => {
      const times = Array.from({ length: 4 }, () => lerp(0.06, 0.78, Math.random()) * D).sort((a, b) => a - b);
      const swapAt = 1 + Math.floor(Math.random() * 3);
      times.forEach((t, j) => {
        const amp = (0.025 + Math.random() * 0.09) * vw * (Math.random() < 0.5 ? -1 : 1);
        tl.to(slice, { x: amp, duration: 0.07, ease: "power4.out" }, t);
        if (j === swapAt) tl.call(() => { slice.textContent = text; }, null, t);
      });
      tl.to(slice, { x: 0, duration: 0.24, ease: "power3.out" }, D * 0.82);
    });
    // The grey copy of the new name slides in and out underneath ("lostella").
    tl.fromTo(dom.ghost, { opacity: 0, x: -0.06 * vw }, { opacity: 0.55, x: 0.01 * vw, duration: D * 0.34, ease: "power2.out" }, D * 0.16)
      .to(dom.ghost, { opacity: 0, x: 0.05 * vw, duration: D * 0.3, ease: "power2.in" }, D * 0.58)
      .call(() => { dom.spacer.textContent = text; }, null, D * 0.5)
      .call(() => {
        slices.forEach((slice) => { slice.textContent = text; });
        dom.nameLive.textContent = `${look.subtitle} — ترند رقم ${look.rank}`;
      }, null, D * 0.86);
  }

  /**
   * Switch to look `to`. camAt = where the new look's camera starts
   * (0 = head; 1 = shoes when arriving backwards by scrolling up).
   */
  function goTo(to, { camAt = 0 } = {}) {
    if (state.locked || !multi() || destroyed) return;
    to = wrap(to);
    if (to === state.index) return;
    state.locked = true;
    hideHint();

    const from = state.index;
    const look = LOOKS[to];
    const next = LOOKS[wrap(to + 1)];
    const D = reduced.matches ? TUNE.duration * 0.7 : TUNE.duration;

    if (renderer) {
      texture(from);
      texture(to);
    }
    if (fallbackImgs.length) fallbackImgs[to].style.opacity = "0";

    state.trans = { from, to, p: 0, zoom2: reduced.matches ? 1 : 1.06, drift: 0, oldCam: state.cam, seed: Math.random() * 100 };
    state.push = 0;
    selectDot(to);

    const tl = gsap.timeline({ onComplete: () => finish(to) });
    timeline = tl;
    tl.to(state.trans, { p: 1, duration: D, ease: TUNE.ease }, 0)
      .to(state.trans, { zoom2: 1, duration: D, ease: "power2.out" }, 0)
      .to(state.trans, { drift: 1, duration: D, ease: "power1.out" }, 0)
      .to(root, { "--th-accent": look.accent, duration: D * 0.8, ease: "power2.inOut" }, 0)
      .call(() => dom.cta.setAttribute("href", look.shopHref), null, D * 0.5);

    // Camera returns to the new look's start while the shader runs.
    state.cam = state.camTarget = camAt;

    nameTimeline(tl, look, D);

    // Arabic line, word by word.
    const oldWords = dom.lineAr.querySelectorAll(".th-w > span");
    tl.to(oldWords, { yPercent: -110, opacity: 0, duration: D * 0.28, stagger: 0.04, ease: "power2.in" }, 0.02)
      .add(() => {
        setWords(dom.lineAr, look.subtitle);
        gsap.fromTo(
          dom.lineAr.querySelectorAll(".th-w > span"),
          { yPercent: 110, opacity: 0 },
          { yPercent: 0, opacity: 1, duration: 0.55, stagger: 0.05, ease: "power3.out", clearProps: "transform,opacity" },
        );
      }, D * 0.42);

    // LOOK 01 / 02 indicator. Opacity only: it is display:none on mobile,
    // and GSAP measuring a transform inside a hidden parent re-parents it.
    tl.to(dom.lookNum, { opacity: 0, duration: 0.22, ease: "power2.in" }, D * 0.22)
      .call(() => setLookIndex(to), null, D * 0.45)
      .to(dom.lookNum, { opacity: 1, duration: 0.4, ease: "power3.out", clearProps: "opacity" }, D * 0.48);

    // Rank badge.
    tl.to(dom.badge, { opacity: 0, y: -6 * state.s, duration: 0.22, ease: "power2.in" }, D * 0.22)
      .call(() => setBadge(look), null, D * 0.45)
      .to(dom.badge, { opacity: 1, y: 0, duration: 0.4, ease: "power3.out", clearProps: "transform,opacity" }, D * 0.48);

    // Cards: out, swap content, in (stagger), then clear for the hover.
    tl.to(dom.cards.querySelectorAll(".th-card-inner"), { y: -40 * state.s, opacity: 0, duration: D * 0.3, stagger: 0.05, ease: "power2.in" }, 0.02)
      .add(() => {
        renderCards(look);
        gsap.fromTo(
          dom.cards.querySelectorAll(".th-card-inner"),
          { y: 50 * state.s, opacity: 0 },
          { y: 0, opacity: 1, duration: 0.6, stagger: 0.08, ease: "power3.out", clearProps: "transform,opacity" },
        );
      }, D * 0.48);

    // Next-trend preview: clip-path wipe from the bottom with scale.
    tl.add(() => swapCrop(dom.nextMedia, next), D * 0.28)
      .call(() => { dom.nextName.textContent = next.title; }, null, D * 0.5);
  }

  function finish(to) {
    timeline = null;
    state.index = to;
    if (fallbackImgs.length) {
      fallbackImgs.forEach((node, i) => { node.style.opacity = i === to ? "1" : "0"; });
    }
    state.trans = null;
    state.locked = false;
    state.cooldownUntil = performance.now() + TUNE.cooldown;
    state.dirty = true;
    pruneTextures();
    warmNeighbours();
  }

  // -------------------------------------------------------------- input
  function hideHint() {
    if (hintHidden) return;
    hintHidden = true;
    dom.hint.classList.add("th-is-hidden");
  }

  /** Moves the camera by d (camera units); past either end it builds "push". */
  function moveCamera(d) {
    if (state.locked || performance.now() < state.cooldownUntil) return;
    hideHint();
    const target = state.camTarget + d;
    state.camTarget = clamp(target, 0, 1);
    if (!multi()) return;

    const atEnd = target > 1 && state.cam > 0.97;
    const atStart = target < 0 && state.cam < 0.03 && state.index > 0;
    if (atEnd || atStart) {
      const overflow = atEnd ? target - 1 : target;
      if (Math.sign(overflow) !== Math.sign(state.push)) state.push = 0;
      state.push += overflow;
      clearTimeout(state.pushTimer);
      state.pushTimer = setTimeout(() => { state.push = 0; }, 320);
      if (state.push >= TUNE.pushToNext) goTo(state.index + 1);
      else if (state.push <= -TUNE.pushToNext) goTo(state.index - 1, { camAt: 1 });
    } else {
      state.push = 0;
    }
  }

  function onWheel(event) {
    event.preventDefault();
    const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? state.vh : 1;
    moveCamera(event.deltaY * unit * TUNE.wheelSpeed);
  }

  function onKey(event) {
    const target = event.target instanceof Element ? event.target : null;
    if (target?.closest("input, textarea, select, [contenteditable]")) return;
    // Only while the hero is on screen.
    const rect = root.getBoundingClientRect();
    if (rect.bottom <= 0 || rect.top >= window.innerHeight) return;
    const onControl = target?.closest("button, a");
    switch (event.key) {
      case "ArrowLeft": event.preventDefault(); goTo(state.index + 1); break;    // RTL: left = next
      case "ArrowRight": event.preventDefault(); goTo(state.index - 1); break;
      case "ArrowDown":
      case "PageDown":
        event.preventDefault(); keyStep(1); break;
      case " ":
        if (onControl) return;
        event.preventDefault(); keyStep(1); break;
      case "ArrowUp":
      case "PageUp":
        event.preventDefault(); keyStep(-1); break;
      default:
    }
  }

  function keyStep(dir) {
    if (state.locked) return;
    hideHint();
    if (dir > 0 && state.camTarget >= 1 && state.cam > 0.97) goTo(state.index + 1);
    else if (dir < 0 && state.camTarget <= 0 && state.cam < 0.03 && state.index > 0) goTo(state.index - 1, { camAt: 1 });
    else state.camTarget = clamp(state.camTarget + dir * 0.34, 0, 1);
  }

  // Pointer: vertical drag = camera, horizontal swipe = transition.
  const drag = { id: null, x: 0, y: 0, lastY: 0, axis: null };
  function onPointerDown(event) {
    if (event.pointerType === "mouse" && event.button !== 0) return;
    if (event.target instanceof Element && event.target.closest("button, a")) return;
    drag.id = event.pointerId;
    drag.x = event.clientX;
    drag.y = drag.lastY = event.clientY;
    drag.axis = null;
  }
  function onPointerMove(event) {
    if (event.pointerType === "mouse") {
      const r = root.getBoundingClientRect();
      state.mouse.tx = clamp(((event.clientX - r.left) / state.vw - 0.5) * 2, -1, 1);
      state.mouse.ty = clamp(((event.clientY - r.top) / state.vh - 0.5) * 2, -1, 1);
    }
    if (drag.id !== event.pointerId) return;
    const dx = event.clientX - drag.x;
    const dy = event.clientY - drag.y;
    if (!drag.axis && Math.hypot(dx, dy) > 10) {
      drag.axis = Math.abs(dx) > Math.abs(dy) ? "x" : "y";
      try {
        root.setPointerCapture(event.pointerId);
      } catch {
        // pointer already gone (e.g. released mid-gesture): drag still works without capture
      }
    }
    if (drag.axis === "y") {
      moveCamera(-(event.clientY - drag.lastY) / (state.vh * 0.85));
    }
    drag.lastY = event.clientY;
  }
  function onPointerUp(event) {
    if (drag.id !== event.pointerId) return;
    const dx = event.clientX - drag.x;
    if (drag.axis === "x" && Math.abs(dx) > 50 && performance.now() >= state.cooldownUntil) {
      goTo(dx < 0 ? state.index + 1 : state.index - 1);   // swipe left = next (RTL)
    }
    drag.id = null;
    drag.axis = null;
  }

  // --------------------------------------------------------------- loop
  function setTransform(node, key, value) {
    if (state.last[key] === value) return;
    state.last[key] = value;
    node.style.transform = value;
  }

  function updateDom() {
    const { cam, s } = state;
    // On mobile the name sits under the header, so it stays put.
    const rise = state.frame.name === "mobile" ? 0 : -cam * TUNE.nameParallax * s;
    setTransform(dom.nameWrap, "name", `translate3d(0, ${rise.toFixed(2)}px, 0)`);
    setTransform(dom.info, "info", `translate3d(0, ${rise.toFixed(2)}px, 0)`);
    setTransform(dom.camDot, "camDot", `translate3d(0, ${(cam * state.camTrackH).toFixed(2)}px, 0)`);
    setTransform(dom.bgWord, "bgWord", `translate3d(${(-state.mouse.x * 4 * s).toFixed(2)}px, ${(-cam * TUNE.bgWordParallax * s).toFixed(2)}px, 0)`);

    // Cards follow the camera: the piece in frame takes the focus.
    const boxes = state.cardBoxes;
    if (boxes.length) {
      const n = boxes.length;
      const f = n > 1 ? clamp((cam - 0.15) / 0.7, 0, 1) * (n - 1) : 0;
      const mobile = state.frame.name === "mobile";
      if (mobile) {
        // Mobile: one card at a time, centred, sliding with the camera.
        const i0 = Math.floor(f);
        const i1 = Math.min(n - 1, i0 + 1);
        const left = lerp(boxes[i0].left, boxes[i1].left, f - i0);
        const anchor = (state.vw - boxes[i0].width) / 2;
        setTransform(dom.cards, "cards", `translate3d(${(anchor - left).toFixed(2)}px, 0, 0)`);
      } else {
        // Desktop: all cards stacked on the left, fully visible; the piece in frame keeps the focus.
        setTransform(dom.cards, "cards", `translate3d(0, ${(-cam * TUNE.cardsParallax * s).toFixed(2)}px, 0)`);
      }
      const opacities = (state.last.cardOpacity ||= []);
      Array.from(dom.cards.children).forEach((card, i) => {
        const dist = Math.min(1, Math.abs(i - f));
        const o = (mobile ? 1 - dist : 1 - dist * 0.4).toFixed(3);
        if (opacities[i] !== o) {
          opacities[i] = o;
          card.style.opacity = o;
          card.style.pointerEvents = Number(o) < 0.2 ? "none" : "";
        }
      });
    }
  }

  function renderStage(time) {
    const t = state.trans;
    if (renderer) {
      const rect1 = t ? figureRect(t.from, t.oldCam, 1 + 0.03 * t.drift, -30 * state.s * t.drift) : figureRect(state.index, state.cam);
      const rect2 = t ? figureRect(t.to, state.cam, t.zoom2) : rect1;
      renderer.render({
        tex1: texture(t ? t.from : state.index),
        tex2: t ? texture(t.to) : null,
        rect1: toCanvas(rect1),
        rect2: toCanvas(rect2),
        progress: t ? t.p : 0,
        time,
        intensity: reduced.matches ? 0 : TUNE.glitch,
        slices: TUNE.slices,
        shadow: TUNE.shadow,
        seed: t ? t.seed : 0,
        px: state.dpr,
      });
    } else if (fallbackImgs.length) {
      const place = (node, r) => {
        const k = r[3] / (state.vh * state.frame.zoom);
        node.style.transform = `translate3d(${r[0].toFixed(2)}px, ${r[1].toFixed(2)}px, 0) scale(${k.toFixed(4)})`;
      };
      if (t) {
        place(fallbackImgs[t.from], figureRect(t.from, t.oldCam, 1 + 0.03 * t.drift));
        place(fallbackImgs[t.to], figureRect(t.to, state.cam, t.zoom2));
        fallbackImgs[t.from].style.opacity = String(1 - t.p);
        fallbackImgs[t.to].style.opacity = String(t.p);
      } else {
        place(fallbackImgs[state.index], figureRect(state.index, state.cam));
      }
    }
  }

  function tick(time, deltaMs) {
    const k = 1 - Math.pow(1 - TUNE.camEase, Math.min(deltaMs, 100) / 16.667);
    const prevCam = state.cam;
    state.cam += (state.camTarget - state.cam) * k;
    if (Math.abs(state.camTarget - state.cam) < 0.0004) state.cam = state.camTarget;

    const m = state.mouse;
    const mk = 1 - Math.pow(0.92, Math.min(deltaMs, 100) / 16.667);
    const pmx = m.x;
    const pmy = m.y;
    m.x += (m.tx - m.x) * mk;
    m.y += (m.ty - m.y) * mk;

    const moving = state.cam !== prevCam || Math.abs(m.x - pmx) > 1e-4 || Math.abs(m.y - pmy) > 1e-4;
    if (!moving && !state.trans && !state.dirty) return;   // idle: nothing to draw
    state.dirty = false;
    updateDom();
    renderStage(time);
  }

  // --------------------------------------------------------------- init
  function intro() {
    const ease = "power3.out";
    if (reduced.matches) {
      gsap.from([dom.nameWrap, dom.info, dom.cards, dom.controls], { opacity: 0, duration: 0.6, ease });
    } else {
      gsap.from(dom.slicesWrap.children, { yPercent: 40, opacity: 0, duration: 1, stagger: 0.04, ease, clearProps: "transform,opacity" });
      gsap.from(dom.info, { y: 24 * state.s, opacity: 0, duration: 0.9, delay: 0.15, ease, clearProps: "opacity" });
      gsap.from(dom.cards.querySelectorAll(".th-card-inner"), { y: 40 * state.s, opacity: 0, duration: 0.9, stagger: 0.08, delay: 0.25, ease, clearProps: "transform,opacity" });
      gsap.from([dom.controls, dom.nextBox, dom.cam], { opacity: 0, duration: 0.8, delay: 0.35, ease, clearProps: "opacity" });
    }
  }

  async function init() {
    await preload();
    if (destroyed) return;

    renderer = GlitchRenderer.create(dom.canvas, () => { if (!destroyed) enterFallback(); });
    if (!renderer) enterFallback();

    dom.hero.classList.toggle("th-no-nav", !multi());
    renderDots();
    applyLook(0);
    resize();
    if (renderer) {
      texture(0);
      warmNeighbours();
    }

    const ro = new ResizeObserver(() => resize());
    ro.observe(root);
    cleanups.push(() => ro.disconnect());
    listen(root, "wheel", onWheel, { passive: false });
    listen(root, "pointerdown", onPointerDown);
    listen(window, "pointermove", onPointerMove);
    listen(window, "pointerup", onPointerUp);
    listen(window, "pointercancel", onPointerUp);
    listen(window, "keydown", onKey);
    listen(dom.prev, "click", () => goTo(state.index - 1));
    listen(dom.next, "click", () => goTo(state.index + 1));
    listen(dom.nextBox, "click", () => goTo(state.index + 1));
    listen(root, "mouseleave", () => { state.mouse.tx = 0; state.mouse.ty = 0; });
    dom.prev.disabled = dom.next.disabled = !multi();

    gsap.ticker.lagSmoothing(500, 33);
    gsap.ticker.add(tick);
    cleanups.push(() => gsap.ticker.remove(tick));
    dom.loader.classList.add("th-is-done");
    dom.loader.setAttribute("aria-hidden", "true");
    state.locked = false;
    intro();
  }

  init().catch((error) => {
    if (destroyed) return;
    console.error("[trend-hero]", error);
    dom.loaderPct.textContent = "!";
    dom.loaderBrand.textContent = "تعذّر تحميل الإطلالات";
  });

  return function destroy() {
    destroyed = true;
    timeline?.kill();
    gsap.killTweensOf(root.querySelectorAll("*"));
    gsap.killTweensOf(root);
    clearTimeout(state.pushTimer);
    cleanups.splice(0).forEach((fn) => fn());
    if (renderer) {
      for (const tex of textures.values()) renderer.deleteTexture(tex);
      textures.clear();
      renderer.gl.getExtension("WEBGL_lose_context")?.loseContext();
      renderer = null;
    }
  };
}
