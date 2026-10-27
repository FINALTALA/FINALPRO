// Inline stroke icons for the Advertising page (the design's lucide set,
// drawn as plain SVG so no icon package is added). 24-unit grid, 2px round
// strokes; size and colour come from CSS (width/height, currentColor).

type P = { className?: string };
const svg = (paths: React.ReactNode, filled = false) =>
  function Icon({ className }: P) {
    return (
      <svg
        className={className}
        viewBox="0 0 24 24"
        fill={filled ? "currentColor" : "none"}
        stroke="currentColor"
        strokeWidth={2}
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
      >
        {paths}
      </svg>
    );
  };

export const ChevronLeft = svg(<path d="m15 18-6-6 6-6" />);
export const ChevronRight = svg(<path d="m9 18 6-6-6-6" />);
export const ChevronUp = svg(<path d="m18 15-6-6-6 6" />);
export const ChevronDown = svg(<path d="m6 9 6 6 6-6" />);
export const ArrowUpRight = svg(<><path d="M7 7h10v10" /><path d="M7 17 17 7" /></>);
export const ArrowUpLeft = svg(<><path d="M7 17V7h10" /><path d="M17 17 7 7" /></>);
export const Sliders = svg(
  <>
    <path d="M21 4h-7M10 4H3M21 12h-9M8 12H3M21 20h-5M12 20H3M14 2v4M8 10v4M16 18v4" />
  </>,
);
export const Play = svg(<polygon points="6 3 20 12 6 21 6 3" />, true);
export const Pause = svg(<><rect x="14" y="4" width="4" height="16" rx="1" /><rect x="6" y="4" width="4" height="16" rx="1" /></>);
export const Close = svg(<path d="M18 6 6 18M6 6l12 12" />);
export const VolumeOn = svg(
  <><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" /><path d="M15.54 8.46a5 5 0 0 1 0 7.07M19.07 4.93a10 10 0 0 1 0 14.14" /></>,
);
export const VolumeOff = svg(<><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" /><path d="m22 9-6 6M16 9l6 6" /></>);
export const Heart = svg(
  <path d="M19 14c1.49-1.46 3-3.21 3-5.5A5.5 5.5 0 0 0 16.5 3c-1.76 0-3 .5-4.5 2-1.5-1.5-2.74-2-4.5-2A5.5 5.5 0 0 0 2 8.5c0 2.3 1.5 4.05 3 5.5l7 7Z" />,
);
export const Bookmark = svg(<path d="m19 21-7-4-7 4V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2v16z" />);
export const Share = svg(
  <><circle cx="18" cy="5" r="3" /><circle cx="6" cy="12" r="3" /><circle cx="18" cy="19" r="3" /><path d="m8.59 13.51 6.83 3.98M15.41 6.51l-6.82 3.98" /></>,
);
export const CommentsOff = svg(
  <path d="M20.5 14.9A9 9 0 0 0 9.1 3.5M2 2l20 20M5.6 5.6C3 8.3 2.2 12.5 4 16l-2 6 6-2c3.4 1.8 7.6 1.1 10.3-1.7" />,
);
export const Bag = svg(<><path d="M6 2 3 6v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V6l-3-4Z" /><path d="M3 6h18M16 10a4 4 0 0 1-8 0" /></>);
export const Check = svg(<path d="M20 6 9 17l-5-5" />);
