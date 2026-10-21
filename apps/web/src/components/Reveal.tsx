"use client";

import { useEffect } from "react";
import { ScrollTrigger } from "gsap/ScrollTrigger";
import AnimatedContent, { type AnimatedContentProps } from "./AnimatedContent";

// Shared ResizeObserver: browse pages swap skeletons for API data after
// mount, which shifts every section below. ScrollTrigger only re-measures
// on window resize, so without this a trigger can be left pointing at a
// stale offset and keep its section hidden.
let watchers = 0;
let observer: ResizeObserver | null = null;
let frame = 0;

function watchLayout(): () => void {
  if (watchers++ === 0 && typeof ResizeObserver !== "undefined") {
    observer = new ResizeObserver(() => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => ScrollTrigger.refresh());
    });
    observer.observe(document.body);
  }
  return () => {
    if (--watchers === 0) {
      observer?.disconnect();
      observer = null;
      cancelAnimationFrame(frame);
    }
  };
}

// Calm scroll-in reveal for storefront content sections. Not for
// checkout, forms, or admin/vendor screens. AnimatedContent already
// skips the motion under prefers-reduced-motion.
export default function Reveal(props: AnimatedContentProps) {
  useEffect(watchLayout, []);
  return <AnimatedContent distance={24} duration={0.7} ease="power3.out" once {...props} />;
}
