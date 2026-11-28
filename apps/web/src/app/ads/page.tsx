import Footer from "@/components/Footer";
import AdsFeaturedAds from "@/components/ads/AdsFeaturedAds";
import AdsFeaturedStores from "@/components/ads/AdsFeaturedStores";
import AdsHero from "@/components/ads/AdsHero";
import AdsOfferEdit from "@/components/ads/AdsOfferEdit";
import AdsPageShell from "@/components/ads/AdsPageShell";
import AdsReels from "@/components/ads/AdsReels";
import AdsStories from "@/components/ads/AdsStories";
import { ManagedContentProvider } from "@/lib/contentStudio";

// The Advertising page (AI Studio design, ported into Via): hero, stories,
// reels, featured ads, featured stores, offers. The site header comes from
// AppShell; the footer is the shared Footer. VIA phase 6: hero, stories,
// reels, featured ads and featured stores may come from the Content Studio
// (editorial placements only; the offers block stays the live catalogue).
export default function AdsPage() {
  return (
    <ManagedContentProvider page="ADS">
      <AdsPageShell>
        <AdsHero />
        <AdsStories />
        <AdsReels />
        <AdsFeaturedAds />
        <AdsFeaturedStores />
        <AdsOfferEdit />
      </AdsPageShell>
      {/* The shared layout renders no site footer: pages add it (as / and
          /women do). Outside the page wrapper, so it keeps Via's own styles. */}
      <Footer brand="VIA" />
    </ManagedContentProvider>
  );
}
