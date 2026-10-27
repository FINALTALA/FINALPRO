"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useAdsLang } from "./adsCopy";
import { StoreMark } from "./AdsShared";
import type { Reel } from "./data/adsDemo";
import {
  ArrowUpLeft, ArrowUpRight, Bag, Bookmark, Check, ChevronDown, ChevronUp, Close,
  CommentsOff, Heart, Play, Share, VolumeOff, VolumeOn,
} from "./icons";

// Reels viewer (AI Studio ReelsViewerModal). The layout is kept whole; what
// has no backend for these demo reels is shown but inert and says so:
//  - Follow: Via follows real stores only (PUT /customers/me/following/:slug);
//    a demo store has none -> inert.
//  - Like: Via has no reel likes -> inert, no count (none is invented).
//  - Save: Via favourites are product variants; demo products have none -> inert.
//  - Comments: off, as in the design.
//  - Share: works (copies the page link).
//  - Shop the Look: the demo products are listed without prices (none are
//    real) and without product links.

export default function ReelsViewer({ reels, index, onIndex, onClose }: {
  reels: Reel[];
  index: number;
  onIndex: (i: number) => void;
  onClose: () => void;
}) {
  const { t, pick, isArabic, dir } = useAdsLang();
  const [muted, setMuted] = useState(true);
  const [playing, setPlaying] = useState(true);
  const [progress, setProgress] = useState(0);
  const [copied, setCopied] = useState(false);
  const [drawer, setDrawer] = useState(false);
  const videoRef = useRef<HTMLVideoElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const reel = reels[index];

  useEffect(() => {
    const before = document.activeElement as HTMLElement | null;
    const y = window.scrollY;
    closeRef.current?.focus();
    return () => {
      before?.focus?.({ preventScroll: true });
      window.scrollTo({ top: y });
    };
  }, []);

  const go = useCallback((to: number) => {
    onIndex((to + reels.length) % reels.length);
    setProgress(0);
    setDrawer(false);
    setPlaying(true);
  }, [onIndex, reels.length]);

  const togglePlay = useCallback(() => {
    const v = videoRef.current;
    if (!v) return;
    if (v.paused) { v.play().catch(() => undefined); setPlaying(true); }
    else { v.pause(); setPlaying(false); }
  }, []);

  const setDrawerOpen = useCallback((open: boolean) => {
    setDrawer(open);
    const v = videoRef.current;
    if (!v) return;
    if (open) { v.pause(); setPlaying(false); }
    else { v.play().catch(() => undefined); setPlaying(true); }
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") { if (drawer) setDrawerOpen(false); else onClose(); }
      else if (e.key === "ArrowDown" || e.key === "j") { e.preventDefault(); go(index + 1); }
      else if (e.key === "ArrowUp" || e.key === "k") { e.preventDefault(); go(index - 1); }
      else if (e.key === " ") { e.preventDefault(); togglePlay(); }
    };
    const onHide = () => {
      if (document.hidden) { videoRef.current?.pause(); setPlaying(false); }
    };
    window.addEventListener("keydown", onKey);
    document.addEventListener("visibilitychange", onHide);
    return () => {
      window.removeEventListener("keydown", onKey);
      document.removeEventListener("visibilitychange", onHide);
    };
  }, [drawer, go, index, onClose, setDrawerOpen, togglePlay]);

  const share = (e: React.MouseEvent) => {
    e.stopPropagation();
    navigator.clipboard?.writeText(window.location.href).then(() => {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    }).catch(() => undefined);
  };

  if (!reel) return null;
  const hasProducts = reel.products.length > 0;
  const Arrow = isArabic ? ArrowUpLeft : ArrowUpRight;
  const demoTitle = t("ads.unavailableDemo");

  const productList = (compact: boolean) => (
    <div className={compact ? "rv-list is-compact" : "rv-list"}>
      {reel.products.map((p) => (
        <div key={p.id} className="rv-prod">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={p.image} alt={pick(p.name)} />
          <div className="rv-prod-text">
            <p className="rv-prod-name">{pick(p.name)}</p>
            <p className="rv-prod-store">{pick(p.store.name)}</p>
            <p className="rv-prod-price">{p.price != null ? `₪ ${p.price}` : <span className="ads-demo">{t("ads.reel.priceUnavailable")}</span>}</p>
          </div>
          {!compact && (
            p.href ? (
              <a href={p.href} className="rv-prod-go" aria-label={t("ads.reel.viewProduct")}><Arrow /></a>
            ) : (
              <span className="rv-prod-go is-unavailable" role="link" aria-disabled="true" aria-label={t("ads.reel.viewProduct")} title={demoTitle}><Arrow /></span>
            )
          )}
        </div>
      ))}
    </div>
  );

  return (
    <div className="ads-modal is-reels" role="dialog" aria-modal="true" aria-label={t("ads.reel.viewer")} onClick={onClose}>
      <div className="rv-wrap" onClick={(e) => e.stopPropagation()}>
        {/* Shop the Look - desktop drawer beside the video. */}
        {drawer && hasProducts && (
          <aside className="rv-drawer" dir={dir} aria-label={t("ads.reel.shopLook")}>
            <div>
              <div className="rv-drawer-head">
                <div className="rv-drawer-title"><Bag /><h3>{t("ads.reel.shopLook")}</h3></div>
                <button type="button" className="rv-x" onClick={() => setDrawerOpen(false)} aria-label={t("ads.reel.closeDrawer")}><Close /></button>
              </div>
              {productList(false)}
            </div>
            <div className="rv-drawer-foot">
              <span className="rv-visit is-unavailable" role="link" aria-disabled="true" title={demoTitle}>{t("ads.reel.visitStore")}</span>
            </div>
          </aside>
        )}

        <div className="rv-frame">
          <video
            ref={videoRef}
            key={reel.id}
            src={reel.video}
            autoPlay
            playsInline
            loop
            muted={muted}
            onTimeUpdate={(e) => {
              const v = e.currentTarget;
              if (v.duration > 0) setProgress((v.currentTime / v.duration) * 100);
            }}
            onClick={togglePlay}
          />
          <div className="sv-scrim rv-scrim-top" aria-hidden="true" />
          <div className="sv-scrim rv-scrim-bottom" aria-hidden="true" />
          {!playing && (
            <div className="rv-paused" aria-hidden="true"><span><Play /></span></div>
          )}

          <div className="rv-top">
            <div className="rv-progress"><div style={{ width: `${progress}%` }} /></div>
            <div className="sv-head" dir={dir}>
              <div className="sv-id">
                <StoreMark store={reel.store} size={32} className="is-glass" />
                <div className="sv-id-text">
                  <div className="rv-name-row">
                    <p className="sv-name">{pick(reel.store.name)}</p>
                    {/* Follow: real stores only. */}
                    <button type="button" className="rv-follow is-unavailable" aria-disabled="true" title={demoTitle} onClick={(e) => e.stopPropagation()}>
                      {t("ads.reel.follow")}
                    </button>
                    {reel.store.demo && <span className="ads-demo is-light">{t("ads.demo")}</span>}
                  </div>
                  {reel.sponsored && <span className="rv-sponsored">{t("ads.sponsoredContent")}</span>}
                </div>
              </div>
              <div className="sv-ctl">
                <button type="button" className="sv-btn rv-btn" aria-label={muted ? t("ads.video.unmute") : t("ads.video.mute")} onClick={(e) => { e.stopPropagation(); setMuted((m) => !m); }}>
                  {muted ? <VolumeOff /> : <VolumeOn />}
                </button>
                <button ref={closeRef} type="button" className="sv-btn rv-btn" onClick={onClose} aria-label={t("ads.reel.close")}><Close /></button>
              </div>
            </div>
          </div>

          {/* Social actions (end side). */}
          <div className={`rv-actions${isArabic ? " is-left" : " is-right"}`}>
            <div className="rv-action is-unavailable" title={demoTitle}>
              <button type="button" aria-disabled="true" aria-label={t("ads.reel.like")} onClick={(e) => e.stopPropagation()}><Heart /></button>
              <span>{reel.likes != null ? reel.likes : t("ads.reel.like")}</span>
            </div>
            <div className="rv-action is-unavailable" title={demoTitle}>
              <button type="button" aria-disabled="true" aria-label={t("ads.reel.save")} onClick={(e) => e.stopPropagation()}><Bookmark /></button>
              <span>{t("ads.reel.save")}</span>
            </div>
            <div className="rv-action is-off" title={t("ads.reel.commentsOffTitle")}>
              <span className="rv-action-icon"><CommentsOff /></span>
              <span>{t("ads.reel.commentsOff")}</span>
            </div>
            <div className="rv-action">
              <button type="button" aria-label={t("ads.reel.share")} onClick={share}>{copied ? <Check className="is-ok" /> : <Share />}</button>
              <span>{copied ? t("ads.reel.copied") : t("ads.reel.share")}</span>
            </div>
          </div>

          <div className="rv-bottom" dir={dir}>
            <div className="rv-copy">
              <h4>{pick(reel.title)}</h4>
              <p>{pick(reel.caption)}</p>
            </div>
            <div className="rv-cta-row">
              {hasProducts && (
                <button type="button" className={`rv-shop${drawer ? " is-on" : ""}`} onClick={(e) => { e.stopPropagation(); setDrawerOpen(!drawer); }}>
                  <span className="rv-shop-l"><Bag /><span>{t("ads.reel.shopLook")}</span></span>
                  <span className="rv-shop-n">({reel.products.length})</span>
                </button>
              )}
              <span className={`rv-store is-unavailable${hasProducts ? "" : " is-wide"}`} role="link" aria-disabled="true" title={demoTitle}>
                <span>{t("ads.browseStore")}</span>
                <Arrow />
              </span>
            </div>
          </div>

          {/* Shop the Look - mobile bottom sheet. */}
          {drawer && hasProducts && (
            <div className="rv-sheet" dir={dir} onClick={(e) => e.stopPropagation()}>
              <div>
                <div className="rv-drawer-head">
                  <div className="rv-drawer-title"><Bag /><h3>{t("ads.reel.shopLook")}</h3></div>
                  <button type="button" className="rv-x" onClick={() => setDrawerOpen(false)} aria-label={t("ads.reel.closeDrawer")}><Close /></button>
                </div>
                {productList(true)}
              </div>
              <div className="rv-drawer-foot">
                <span className="rv-visit is-unavailable" role="link" aria-disabled="true" title={demoTitle}>{t("ads.reel.visitStore")}</span>
              </div>
            </div>
          )}
        </div>

        <div className="rv-nav">
          <button type="button" onClick={() => go(index - 1)} aria-label={t("ads.reel.prev")}><ChevronUp /></button>
          <button type="button" onClick={() => go(index + 1)} aria-label={t("ads.reel.next")}><ChevronDown /></button>
        </div>
      </div>
    </div>
  );
}
