"use client";

import Image from "next/image";
import { CSSProperties, useEffect, useRef } from "react";
import { WomenCategory } from "@/lib/womenCategories";

export interface CountedWomenCategory extends WomenCategory {
  count: number;
}

export default function WomenCategorySection({
  categories,
  selectedCategory,
  onSelectCategory,
}: {
  categories: CountedWomenCategory[];
  selectedCategory: string;
  onSelectCategory: (category: string) => void;
}) {
  const listRef = useRef<HTMLDivElement>(null);

  // Staggered entrance, once per page load. The hidden start state lives
  // in CSS behind `@media (scripting: enabled)`, so without JS the circles
  // are simply visible; this only flips the list to "shown" once it
  // enters the viewport. The motion itself is the CSS transition.
  useEffect(() => {
    const list = listRef.current;
    if (!list) return;
    if (typeof IntersectionObserver === "undefined") {
      list.dataset.reveal = "shown";
      return;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        if (!entries.some((entry) => entry.isIntersecting)) return;
        list.dataset.reveal = "shown";
        observer.disconnect();
      },
      { threshold: 0.15 },
    );
    observer.observe(list);
    return () => observer.disconnect();
  }, []);

  return (
    <section className="women-categories" aria-label="تصنيفات الأزياء" id="women-categories">
      <div className="women-category-list" role="list" aria-label="جميع تصنيفات الأزياء" ref={listRef}>
        {categories.map((item, index) => {
          const isSelected = selectedCategory === item.slug;
          return (
            <div
              className="women-category-item"
              key={item.slug}
              role="listitem"
              style={{ "--reveal-index": index } as CSSProperties}
            >
              <button
                className={`women-category-card${isSelected ? " selected" : ""}`}
                type="button"
                onClick={() => onSelectCategory(isSelected ? "" : item.slug)}
                aria-pressed={isSelected}
                aria-label={`${item.label}: ${item.count} منتج`}
              >
                <span className="women-category-image">
                  <Image src={item.image} alt="" fill sizes="(max-width: 639px) 52px, 64px" />
                  {isSelected && (
                    <span className="women-category-check" aria-hidden="true">
                      <svg viewBox="0 0 12 12" fill="none">
                        <path d="m2.5 6 2.2 2.2 4.8-4.8" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
                      </svg>
                    </span>
                  )}
                </span>
                <span className="women-category-name">{item.label}</span>
              </button>
            </div>
          );
        })}
      </div>
    </section>
  );
}
