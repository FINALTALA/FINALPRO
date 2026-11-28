"use client";

import CollectionShowcase from "@/components/CollectionShowcase";
import HomeHero from "@/components/home-hero/HomeHero";
import HomeSteps from "@/components/home-steps/HomeSteps";
import HomeCategories from "@/components/home-categories/HomeCategories";
import HomeProducts from "@/components/home-products/HomeProducts";
import HomeStories from "@/components/home-stories/HomeStories";
import HomeStores from "@/components/home-stores/HomeStores";
import HomeHowVia from "@/components/home-how-via/HomeHowVia";
import HomeFooter from "@/components/home-footer/HomeFooter";
import { useHomeReveal } from "@/components/home-motion/useHomeReveal";
import "@/components/home-motion/home-motion.css";
import { useRef } from "react";
import { ManagedContentProvider } from "@/lib/contentStudio";
import styles from "./home-editorial.module.css";

export default function Home() {
  // Scroll-in reveal for every section below the hero (useHomeReveal.ts).
  const root = useRef<HTMLDivElement>(null);
  useHomeReveal(root);

  // VIA phase 6: the editorial sections read their published Content Studio
  // content (their built-in content until the page is managed).
  return (
    <ManagedContentProvider page="HOMEPAGE">
    <div ref={root} className={`${styles.home} page-shell home-editorial`}>
      <HomeHero />

      {/* How shopping on VIA works: right under the hero. */}
      <HomeSteps />

      {/* id: the hero CTA's scroll target. */}
      <div id="shop-by-category" className={`wide-shell ${styles.categoryIntro}`}>
        <HomeCategories />
        <HomeStories />
        <HomeProducts />

        {/* PD-5b: the platform's live home collections. */}
        <CollectionShowcase placement="HOME" />
        <HomeStores />
        <HomeHowVia />
      </div>

      <HomeFooter />
    </div>
    </ManagedContentProvider>
  );
}
