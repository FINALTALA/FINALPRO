/**
 * The store's management frame (the storefront's large «إدارة» window loads
 * workspace pages in an iframe, <html data-embed="management">) is the ONE
 * management window. Screens opened inside it - «منتج جديد», «تعديل المنتج»,
 * «التفاصيل», «مسوداتي», «الاستيراد» - replace its content instead of
 * opening a second panel, and the frame's own header carries their title,
 * the single «رجوع» arrow and the single ×.
 *
 * This is the iframe side of that header: screens register here; the frame
 * (store/[slug]/page.tsx) is told the current title and whether «رجوع» has
 * somewhere to go, and asks back for «رجوع» and × (× lets a screen with
 * something unsaved - the wizard - save first; the frame closes only once
 * this side says "closed"). Same-origin messages only.
 */

export interface FrameScreen {
  /** The frame header's title while this screen is on top. */
  title: () => string;
  /** «رجوع» in the frame header. */
  back: () => void;
  /** Where «رجوع» goes from this screen, when it is a screen inside it (null: the page under it). */
  backTitle?: () => string | null;
  /** × in the frame header: save what needs saving, then call done (never if saving failed - the screen says why and stays). */
  close: (done: () => void) => void;
}

type ToFrame = { source: "fp-manage"; type: "state"; title: string | null; canBack: boolean; backTitle: string | null } | { source: "fp-manage"; type: "ack" | "closed" | "escape" };
type FromFrame = { source: "fp-manage-frame"; type: "back" | "close" } | { source: "fp-manage-frame"; type: "navigate"; href: string };

const screens: FrameScreen[] = [];
let started = false;
let firstPath = "";
let routeTitle: (pathname: string) => string | null = () => null;
/** Paths that are views of ONE screen (a branch and its tabs): moving between them is not a step «رجوع» undoes. */
let samePlace: (a: string, b: string) => boolean = () => false;
let navigateTo: (href: string) => void = (href) => window.location.assign(href);

export function inManagementFrame(): boolean {
  return typeof document !== "undefined" && document.documentElement.getAttribute("data-embed") === "management" && window.parent !== window;
}

function post(message: ToFrame) {
  try {
    window.parent.postMessage(message, window.location.origin);
  } catch {
    // no frame to tell
  }
}

/** Tells the frame what its header should show now. */
export function reportFrameState() {
  if (!started) return;
  const away = window.location.pathname !== firstPath && !samePlace(firstPath, window.location.pathname);
  const top = screens[screens.length - 1];
  const under = screens[screens.length - 2];
  // «رجوع» names where it goes: the screen under this one, else the page under it (null = the frame's first page)
  const backTitle = top
    ? (top.backTitle?.() ?? (under ? under.title() : routeTitle(window.location.pathname)))
    : away
      ? routeTitle(firstPath)
      : null;
  post({
    source: "fp-manage",
    type: "state",
    title: top ? top.title() : routeTitle(window.location.pathname),
    canBack: Boolean(top) || away,
    backTitle,
  });
}

/** A screen opened inside the frame; returns its removal. */
export function pushFrameScreen(screen: FrameScreen): () => void {
  screens.push(screen);
  reportFrameState();
  return () => {
    const i = screens.lastIndexOf(screen);
    if (i >= 0) screens.splice(i, 1);
    reportFrameState();
  };
}

/** Esc inside the frame closes the management window the same way as its ×. */
export function requestFrameEscape() {
  post({ source: "fp-manage", type: "escape" });
}

/** Called once by the shell inside the management iframe. */
export function startManageFrame(
  titleForPath: (pathname: string) => string | null,
  navigate?: (href: string) => void,
  peers?: (a: string, b: string) => boolean,
) {
  if (started || !inManagementFrame()) return;
  started = true;
  firstPath = window.location.pathname;
  routeTitle = titleForPath;
  if (navigate) navigateTo = navigate;
  if (peers) samePlace = peers;
  window.addEventListener("message", (event: MessageEvent) => {
    if (event.source !== window.parent || event.origin !== window.location.origin) return;
    const data = event.data as FromFrame | null;
    if (!data || data.source !== "fp-manage-frame") return;
    const top = screens[screens.length - 1];
    if (data.type === "back") {
      if (top) top.back();
      else if (window.location.pathname !== firstPath) window.history.back();
      return;
    }
    if (data.type === "navigate") {
      // the frame's own bell: only this store's pages, and an open screen
      // (the wizard) saves first - it stays if saving failed
      if (typeof data.href !== "string" || !data.href.startsWith("/vendor/") || data.href.includes("//")) return;
      const go = () => {
        const next = screens[screens.length - 1];
        if (!next) navigateTo(data.href);
        else next.close(() => {
          const i = screens.lastIndexOf(next);
          if (i >= 0) screens.splice(i, 1);
          go();
        });
      };
      go();
      return;
    }
    if (data.type === "close") {
      post({ source: "fp-manage", type: "ack" });
      const closeAll = () => {
        // every screen still open (a wizard on top of a list screen) gets its chance to save
        const next = screens[screens.length - 1];
        if (!next) post({ source: "fp-manage", type: "closed" });
        else next.close(() => {
          const i = screens.lastIndexOf(next);
          if (i >= 0) screens.splice(i, 1);
          closeAll();
        });
      };
      closeAll();
    }
  });
  reportFrameState();
}
