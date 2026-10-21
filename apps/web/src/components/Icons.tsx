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
export const BellIcon = () => (
  <Icon>
    <path d="M6 10.5a6 6 0 1 1 12 0c0 3 1 4.8 1.8 5.8H4.2C5 15.3 6 13.5 6 10.5z" />
    <path d="M10 19a2 2 0 0 0 4 0" />
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
export const ExpandIcon = () => (
  <Icon>
    <path d="M4 9V5.5A1.5 1.5 0 0 1 5.5 4H9M15 4h3.5A1.5 1.5 0 0 1 20 5.5V9M20 15v3.5a1.5 1.5 0 0 1-1.5 1.5H15M9 20H5.5A1.5 1.5 0 0 1 4 18.5V15" />
  </Icon>
);
export const InstagramIcon = () => (
  <Icon size={19}>
    <rect x="3.5" y="3.5" width="17" height="17" rx="5" />
    <circle cx="12" cy="12" r="4" />
    <circle cx="17.2" cy="6.8" r=".6" fill="currentColor" />
  </Icon>
);
export const FacebookIcon = () => (
  <Icon size={19}>
    <path d="M14.5 8.5H17V5h-2.5A3.5 3.5 0 0 0 11 8.5V11H8.5v3.5H11V21h3.5v-6.5H17l.5-3.5h-3V9a.5.5 0 0 1 .5-.5Z" />
  </Icon>
);
export const WhatsAppIcon = ({ size = 19 }: { size?: number }) => (
  <Icon size={size}>
    <path d="M4 20.5 5.3 16.6A8.5 8.5 0 1 1 8.6 19.3L4 20.5Z" />
    <path d="M9.2 8.6c.2-.5.5-.5.8-.5h.4c.2 0 .4.1.5.4l.6 1.5c.1.2 0 .4-.1.6l-.5.6c-.1.1-.1.3 0 .5.6 1 1.5 1.8 2.5 2.4.2.1.4.1.5-.1l.6-.6c.2-.2.4-.2.6-.1l1.5.7c.2.1.3.3.3.5v.4c0 .3-.1.6-.5.8-.6.4-1.5.5-2.4.2-2.2-.8-4-2.6-4.9-4.8-.3-.9-.2-1.8.1-2.5Z" />
  </Icon>
);
export const StarIcon = () => (
  <Icon size={14}>
    <path
      d="m12 3.5 2.6 5.3 5.9.9-4.3 4.1 1 5.8-5.2-2.7-5.2 2.7 1-5.8-4.3-4.1 5.9-.9L12 3.5Z"
      fill="currentColor"
    />
  </Icon>
);
export const SparkleIcon = () => (
  <Icon size={15}>
    <path d="M12 3v4M12 17v4M3 12h4M17 12h4M6 6l2.5 2.5M15.5 15.5 18 18M18 6l-2.5 2.5M8.5 15.5 6 18" />
  </Icon>
);
export const TagIcon = () => (
  <Icon size={15}>
    <path d="M3.5 12.2V4.5a1 1 0 0 1 1-1h7.7l8.3 8.3a1 1 0 0 1 0 1.4l-7.3 7.3a1 1 0 0 1-1.4 0l-8.3-8.3Z" />
    <circle cx="8" cy="8" r="1.4" />
  </Icon>
);
