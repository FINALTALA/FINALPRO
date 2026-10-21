"use client";

import Image from "next/image";
import Reveal from "@/components/Reveal";
import { useRef, useState } from "react";

type SeasonalOccasion = "eid" | "christmas";
const OCCASIONS: { key: string; title: string; image: string; season?: SeasonalOccasion }[] = [
  { key: "casual", title: "كاجوال", image: "/images/women-occasion-casual.jpg" },
  { key: "workwear", title: "ملابس العمل", image: "/images/women-occasion-work.jpg" },
  { key: "wedding-guest", title: "ضيفة العرس", image: "/images/women-occasion-wedding-guest.jpg" },
  { key: "activewear", title: "ملابس رياضية", image: "/images/women-occasion-activewear.jpg" },
  { key: "soft-elegance", title: "أناقة ناعمة", image: "/images/women-occasion-soft-elegance.jpg" },
  { key: "medical-scrubs", title: "الزي الطبي", image: "/images/women-occasion-medical-scrubs.jpg" },
  { key: "eid", title: "تشكيلة العيد", image: "/images/women-occasion-eid.jpg", season: "eid" },
  { key: "christmas", title: "تشكيلة الميلاد", image: "/images/women-occasion-christmas.jpg", season: "christmas" },
];
const ENABLED_SEASONS = new Set(
  (process.env.NEXT_PUBLIC_WOMEN_SEASONAL_OCCASIONS ?? "")
    .split(",")
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean),
);
const VISIBLE_OCCASIONS = OCCASIONS.filter(
  (occasion) => !occasion.season || ENABLED_SEASONS.has(occasion.season),
);

function OccasionCard({ title, image }: { title: string; image: string }) {
  const [imageFailed, setImageFailed] = useState(false);
  return (
    <a className="women-occasion-card" href="#women-products">
      {!imageFailed && (
        <Image
          src={image}
          alt=""
          fill
          sizes="(max-width: 600px) 62vw, (max-width: 900px) 36vw, 280px"
          onError={() => setImageFailed(true)}
        />
      )}
      <span className="women-occasion-name">{title}</span>
      <span className="women-occasion-arrow" aria-hidden="true">←</span>
    </a>
  );
}

export default function WomenOccasionsSection() {
  const trackRef = useRef<HTMLDivElement>(null);

  function scrollOccasions(direction: 1 | -1) {
    const track = trackRef.current;
    if (!track) return;
    const card = track.firstElementChild as HTMLElement | null;
    const gap = Number.parseFloat(getComputedStyle(track).columnGap) || 0;
    const step = card ? card.offsetWidth + gap : track.clientWidth * 0.8;
    track.scrollBy({ left: -direction * step, behavior: "smooth" });
  }

  return (
    <Reveal>
      <section className="women-occasions" aria-labelledby="women-occasions-title">
        <div className="women-section-heading">
          <div>
            <span className="women-section-kicker">اختيارات من أجلك</span>
            <h2 id="women-occasions-title">تسوّقي حسب مناسبتك</h2>
          </div>
          <div className="women-occasion-controls">
            <button type="button" aria-label="المناسبة السابقة" onClick={() => scrollOccasions(-1)}>
              <span aria-hidden="true">›</span>
            </button>
            <button type="button" aria-label="المناسبة التالية" onClick={() => scrollOccasions(1)}>
              <span aria-hidden="true">‹</span>
            </button>
          </div>
        </div>
        <div className="women-occasion-track" ref={trackRef}>
          {VISIBLE_OCCASIONS.map((occasion) => (
            <OccasionCard key={occasion.key} title={occasion.title} image={occasion.image} />
          ))}
        </div>
      </section>
    </Reveal>
  );
}
