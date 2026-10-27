"use client";

import { useCallback, useMemo, useState, useSyncExternalStore } from "react";
import { useAdsLang } from "./adsCopy";
import { FilterControls, FitTitle, rvDelay, Strip, StoreMark, useCategoryFilter, useReveal, type Feed } from "./AdsShared";
import StoryViewer from "./AdsStoryViewer";
import { STORY_GROUPS, type AdsCategory } from "./data/adsDemo";
import { Play } from "./icons";
import "./ads-stories.css";

// STORIES (AI Studio StoriesSection): one card per store in a single row;
// a card opens that store's stories in the viewer. All groups are demo data
// (see data/adsDemo.ts); "Following" uses the demo groups' own flag because
// a demo store has no real follow behind it.

const EXTRA: AdsCategory[] = ["Shoes", "Bags", "Jewelry", "Sports"];

// Seen stories, per story id, kept in this browser (localStorage). A store
// counts as viewed only once every one of its stories has been shown in
// the viewer - what the visitor actually watched, not what they opened.
const SEEN_KEY = "via.ads.seenStories";
const SEEN_EVENT = "via:ads-seen";
const readSeen = () => {
  try {
    return localStorage.getItem(SEEN_KEY) ?? "";
  } catch {
    return "";
  }
};
const subscribeSeen = (cb: () => void) => {
  window.addEventListener(SEEN_EVENT, cb);
  window.addEventListener("storage", cb);
  return () => {
    window.removeEventListener(SEEN_EVENT, cb);
    window.removeEventListener("storage", cb);
  };
};
const markSeen = (id: string) => {
  const ids = new Set(readSeen().split(",").filter(Boolean));
  if (ids.has(id)) return;
  ids.add(id);
  try {
    localStorage.setItem(SEEN_KEY, [...ids].join(","));
  } catch {
    // Storage unavailable: seen state lasts for this view only.
  }
  window.dispatchEvent(new Event(SEEN_EVENT));
};

export default function AdsStories() {
  const { t, pick, dir } = useAdsLang();
  const [open, setOpen] = useState<number | null>(null);
  const seenRaw = useSyncExternalStore(subscribeSeen, readSeen, () => "");
  const seen = useMemo(() => new Set(seenRaw.split(",").filter(Boolean)), [seenRaw]);
  const [feed, setFeed] = useState<Feed>("discover");
  const cats = useCategoryFilter();
  const intro = useReveal<HTMLDivElement>();
  const bar = useReveal<HTMLDivElement>();

  const groups = useMemo(
    () => STORY_GROUPS.filter((g) => (feed === "discover" || g.followingDemo) && cats.matches(g.categories)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [feed, cats.selected],
  );

  const onSeen = useCallback((storyId: string) => markSeen(storyId), []);

  return (
    <section className="ads-section as" aria-labelledby="stories-heading">
      <div className="ads-wrap">
        {/* Same heading as the other editorial sections; the title stays
            in English in both languages, the line under it is translated. */}
        <div ref={intro} className="ads-intro as-intro" dir={dir}>
          <span className="rv-mask"><span className="ads-kicker rv-up">VIA / STORIES</span></span>
          <FitTitle id="stories-heading" text={t("ads.stories.title")} mobileLines={["STORIES", "TO DISCOVER"]} />
          <span className="rv-mask">
            <p className="ads-intro-sub as-sub rv-up" style={rvDelay(0.3)}>
              {t("ads.stories.sub")}
              <span className="ads-demo" title={t("ads.demoNote")}>{t("ads.demo")}</span>
            </p>
          </span>
        </div>
        <div ref={bar} className="ads-filterbar as-bar rv-fade" style={rvDelay(0.38)} dir={dir}>
          <FilterControls feed={feed} onFeed={setFeed} selected={cats.selected} onToggle={cats.toggle} extra={EXTRA} />
        </div>

        {groups.length === 0 ? (
          <div className="ads-empty" dir={dir}>
            <p>{feed === "following" ? t("ads.stories.emptyFollowing") : t("ads.stories.empty")}</p>
            <button type="button" onClick={() => { cats.setSelected(new Set()); setFeed("discover"); }}>{t("ads.stories.showAll")}</button>
          </div>
        ) : (
          <Strip prevLabel={t("ads.stories.prev")} nextLabel={t("ads.stories.next")}>
            {groups.map((g, k) => {
              const viewed = g.stories.every((st) => seen.has(st.id));
              const count = g.stories.length;
              return (
                <button
                  key={g.store.id}
                  type="button"
                  className={`as-card${viewed ? " is-viewed" : ""}`}
                  onClick={() => setOpen(k)}
                  aria-label={`${t("ads.stories.view", { name: pick(g.store.name) })} - ${count === 1 ? t("ads.story.countOne") : t("ads.story.count", { n: count })}`}
                >
                  <span className="as-cover">
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src={g.cover} alt="" loading="lazy" decoding="async" />
                    <span className="as-cover-shade" aria-hidden="true" />
                    {/* One bar per story; filled once that story was seen. */}
                    <span className="as-segs" aria-hidden="true">
                      {g.stories.map((st) => <i key={st.id} data-seen={seen.has(st.id) ? "" : undefined} />)}
                    </span>
                    <span className="as-hint" aria-hidden="true"><Play />{t("ads.story.watch")}</span>
                  </span>
                  <span className="as-id" dir={dir}>
                    <span className={`as-ring${viewed ? " is-seen" : ""}`}><StoreMark store={g.store} size={26} /></span>
                    <span className="as-name">{pick(g.store.name)}</span>
                  </span>
                </button>
              );
            })}
          </Strip>
        )}
      </div>

      {open !== null && (
        <StoryViewer
          groups={groups}
          storeIndex={open}
          onClose={() => setOpen(null)}
          onStoreChange={setOpen}
          onSeen={onSeen}
        />
      )}
    </section>
  );
}
