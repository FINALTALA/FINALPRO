"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useAdsLang } from "./adsCopy";
import { StoreMark } from "./AdsShared";
import type { StoryGroup } from "./data/adsDemo";
import { ArrowUpLeft, ArrowUpRight, ChevronLeft, ChevronRight, Close, Pause, Play, VolumeOff, VolumeOn } from "./icons";

// Story viewer (AI Studio StoryViewerModal): 9:16 frame, segmented progress
// for the store's stories, videos to their end, images for 3.5 s, then the
// next store. Keyboard: Esc, arrows (by reading direction), Space.

export default function StoryViewer({ groups, storeIndex, onClose, onStoreChange, onSeen }: {
  groups: StoryGroup[];
  storeIndex: number;
  onClose: () => void;
  onStoreChange: (i: number) => void;
  onSeen: (storyId: string) => void;
}) {
  const { t, pick, isArabic, dir } = useAdsLang();
  const [story, setStory] = useState(0);
  const [muted, setMuted] = useState(true);
  const [playing, setPlaying] = useState(true);
  const [progress, setProgress] = useState(0);
  const videoRef = useRef<HTMLVideoElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const acc = useRef(0);
  const group = groups[storeIndex];
  const item = group?.stories[story];

  // A story counts as seen once it is on screen.
  useEffect(() => {
    if (item) onSeen(item.id);
  }, [item, onSeen]);

  // Focus into the dialog; give focus back on close.
  useEffect(() => {
    const before = document.activeElement as HTMLElement | null;
    closeRef.current?.focus();
    return () => before?.focus?.();
  }, []);

  const resetTo = (k: number) => {
    setStory(k);
    setProgress(0);
    acc.current = 0;
  };

  const next = useCallback(() => {
    if (!group) return;
    if (story < group.stories.length - 1) resetTo(story + 1);
    else if (storeIndex < groups.length - 1) { onStoreChange(storeIndex + 1); resetTo(0); }
    else onClose();
  }, [group, story, storeIndex, groups.length, onStoreChange, onClose]);

  const prev = useCallback(() => {
    if (story > 0) resetTo(story - 1);
    else if (storeIndex > 0) { onStoreChange(storeIndex - 1); resetTo(groups[storeIndex - 1].stories.length - 1); }
  }, [story, storeIndex, groups, onStoreChange]);

  // Timed images (3.5 s).
  useEffect(() => {
    if (!item || item.type !== "image") return;
    const total = (item.durationSeconds ?? 3.5) * 1000;
    let raf = 0;
    let last = performance.now();
    const tick = (now: number) => {
      const d = now - last;
      last = now;
      if (playing) {
        acc.current += d;
        setProgress(Math.min((acc.current / total) * 100, 100));
        if (acc.current >= total) {
          acc.current = 0;
          next();
          return;
        }
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [item, playing, next]);

  const togglePlay = useCallback(() => {
    const v = videoRef.current;
    if (item?.type === "video" && v) {
      if (v.paused) { v.play().catch(() => undefined); setPlaying(true); }
      else { v.pause(); setPlaying(false); }
    } else setPlaying((p) => !p);
  }, [item]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
      else if (e.key === "ArrowRight") (isArabic ? prev : next)();
      else if (e.key === "ArrowLeft") (isArabic ? next : prev)();
      else if (e.key === " ") { e.preventDefault(); togglePlay(); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [isArabic, next, prev, onClose, togglePlay]);

  if (!group || !item) return null;
  const Arrow = isArabic ? ArrowUpLeft : ArrowUpRight;

  return (
    <div className="ads-modal" role="dialog" aria-modal="true" aria-label={t("ads.story.viewer")} onClick={onClose}>
      <div className="sv-frame" onClick={(e) => e.stopPropagation()}>
        <div className="sv-media">
          {item.type === "video" ? (
            <video
              ref={videoRef}
              key={item.id}
              src={item.src}
              poster={item.cover}
              autoPlay
              playsInline
              muted={muted}
              onTimeUpdate={(e) => {
                const v = e.currentTarget;
                if (v.duration > 0) setProgress((v.currentTime / v.duration) * 100);
              }}
              onEnded={next}
            />
          ) : (
            // eslint-disable-next-line @next/next/no-img-element
            <img key={item.id} src={item.src} alt={pick(item.caption)} />
          )}
        </div>
        <div className="sv-scrim is-top" aria-hidden="true" />
        <div className="sv-scrim is-bottom" aria-hidden="true" />

        <button type="button" className="sv-zone is-prev" aria-label={t("ads.story.prev")} onClick={prev}>
          {(story > 0 || storeIndex > 0) && <span className="sv-zone-dot"><ChevronLeft /></span>}
        </button>
        <button type="button" className="sv-zone is-next" aria-label={t("ads.story.next")} onClick={next}>
          <span className="sv-zone-dot"><ChevronRight /></span>
        </button>

        <div className="sv-top">
          <div className="sv-bars">
            {group.stories.map((s, k) => (
              <div key={s.id} className="sv-bar">
                <div className="sv-bar-fill" style={{ width: k < story ? "100%" : k === story ? `${progress}%` : "0%" }} />
              </div>
            ))}
          </div>
          <div className="sv-head" dir={dir}>
            <div className="sv-id">
              <StoreMark store={group.store} size={32} className="is-glass" />
              <div className="sv-id-text">
                <p className="sv-name">
                  {pick(group.store.name)}
                  {group.store.demo && <span className="ads-demo is-light">{t("ads.demo")}</span>}
                </p>
                <p className="sv-caption">{pick(item.caption)}</p>
              </div>
            </div>
            <div className="sv-ctl">
              <button type="button" className="sv-btn" onClick={togglePlay} aria-label={playing ? t("ads.story.pause") : t("ads.story.play")}>
                {playing ? <Pause /> : <Play />}
              </button>
              {item.type === "video" && (
                <button
                  type="button"
                  className="sv-btn"
                  aria-label={muted ? t("ads.video.unmute") : t("ads.video.mute")}
                  onClick={(e) => {
                    e.stopPropagation();
                    setMuted((m) => !m);
                  }}
                >
                  {muted ? <VolumeOff /> : <VolumeOn />}
                </button>
              )}
              <button ref={closeRef} type="button" className="sv-btn" onClick={onClose} aria-label={t("ads.story.close")}>
                <Close />
              </button>
            </div>
          </div>
        </div>

        <div className="sv-bottom">
          {/* Demo stores have no store page: the CTA keeps its place, inert. */}
          {group.store.slug ? (
            <a href={`/store/${group.store.slug}`} className="sv-cta" dir={dir}>
              <span>{t("ads.browseStore")}</span>
              <Arrow />
            </a>
          ) : (
            <span className="sv-cta is-unavailable" dir={dir} role="link" aria-disabled="true" title={t("ads.unavailableDemo")}>
              <span>{t("ads.browseStore")}</span>
              <Arrow />
            </span>
          )}
        </div>
      </div>
    </div>
  );
}
