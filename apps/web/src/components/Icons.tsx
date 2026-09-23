import type { ReactNode } from "react";

// Small self-drawn stroke icons (no icon library - keeps the bundle
// light). All decorative: aria-hidden, the label always sits next to
// them or on the wrapping control.
function Icon({ children, size = 22 }: { children: ReactNode; size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.9"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {children}
    </svg>
  );
}

export const HomeIcon = () => (
  <Icon>
    <path d="M3 11.5 12 4l9 7.5" />
    <path d="M5.5 10.5V20h13v-9.5" />
  </Icon>
);
export const CompassIcon = () => (
  <Icon>
    <circle cx="12" cy="12" r="9" />
    <path d="m15.5 8.5-2 5-5 2 2-5z" />
  </Icon>
);
export const CartIcon = () => (
  <Icon>
    <path d="M3 4h2.5l2 11h10l2-8H6.5" />
    <circle cx="9.5" cy="19" r="1.4" />
    <circle cx="16.5" cy="19" r="1.4" />
  </Icon>
);
export const BagIcon = () => (
  <Icon>
    <path d="M5 8h14l-1 12H6z" />
    <path d="M9 8a3 3 0 0 1 6 0" />
  </Icon>
);
export const UserIcon = () => (
  <Icon>
    <circle cx="12" cy="8.5" r="3.6" />
    <path d="M5 20c.8-3.6 3.6-5.4 7-5.4s6.2 1.8 7 5.4" />
  </Icon>
);
export const HeartIcon = () => (
  <Icon>
    <path d="M12 20s-7.5-4.6-7.5-10A4.3 4.3 0 0 1 12 7.4 4.3 4.3 0 0 1 19.5 10c0 5.4-7.5 10-7.5 10z" />
  </Icon>
);
export const SearchIcon = () => (
  <Icon>
    <circle cx="11" cy="11" r="6.5" />
    <path d="m16 16 4.5 4.5" />
  </Icon>
);
export const ShareIcon = () => (
  <Icon>
    <circle cx="6" cy="12" r="2.2" />
    <circle cx="17.5" cy="6" r="2.2" />
    <circle cx="17.5" cy="18" r="2.2" />
    <path d="m8 11 7.4-4M8 13l7.4 4" />
  </Icon>
);
