/** Small line icons for the wizard and «مسوداتي» (decorative: the buttons keep their own words or aria-label). */
const base = { width: 18, height: 18, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 1.8, strokeLinecap: "round" as const, strokeLinejoin: "round" as const, "aria-hidden": true };

export function IconDrafts() {
  return (
    <svg {...base}>
      <path d="M7 4h7l4 4v11a1 1 0 0 1-1 1H7a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1Z" />
      <path d="M14 4v4h4M9 13h6M9 16.5h4" />
    </svg>
  );
}

export function IconClose() {
  return (
    <svg {...base}>
      <path d="M6 6l12 12M18 6L6 18" />
    </svg>
  );
}

export function IconEdit() {
  return (
    <svg {...base} width={15} height={15}>
      <path d="M4 20h4L19 9a2.1 2.1 0 0 0-3-3L5 17v3Z" />
    </svg>
  );
}

export function IconCopy() {
  return (
    <svg {...base} width={16} height={16}>
      <rect x="8" y="8" width="12" height="12" rx="2" />
      <path d="M16 8V5a1 1 0 0 0-1-1H5a1 1 0 0 0-1 1v10a1 1 0 0 0 1 1h3" />
    </svg>
  );
}

export function IconTrash() {
  return (
    <svg {...base} width={16} height={16}>
      <path d="M4 7h16M10 11v6M14 11v6M6 7l1 12a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1l1-12M9 7V4h6v3" />
    </svg>
  );
}

export function IconPlus() {
  return (
    <svg {...base} width={16} height={16}>
      <path d="M12 5v14M5 12h14" />
    </svg>
  );
}

export function IconUpload() {
  return (
    <svg {...base} width={16} height={16}>
      <path d="M12 15V4M7.5 8.5 12 4l4.5 4.5M5 14v5a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-5" />
    </svg>
  );
}

export function IconStore() {
  return (
    <svg {...base} width={16} height={16}>
      <path d="M4 9.5 5.5 4h13L20 9.5M4 9.5a2.7 2.7 0 0 0 5.3 0 2.7 2.7 0 0 0 5.4 0 2.7 2.7 0 0 0 5.3 0M5.5 12v8h13v-8M10 20v-5h4v5" />
    </svg>
  );
}

/** «فتح»: an arrow pointing forward in the reading direction (flips in RTL via .icon-flip-rtl). */
export function IconOpen() {
  return (
    <svg {...base} width={16} height={16} className="icon-flip-rtl">
      <path d="M14 5h5v5M19 5l-8 8M17 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V8a1 1 0 0 1 1-1h5" />
    </svg>
  );
}

export function IconEye() {
  return (
    <svg {...base} width={16} height={16}>
      <path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12Z" />
      <circle cx="12" cy="12" r="2.8" />
    </svg>
  );
}

export function IconBack() {
  return (
    <svg {...base} width={16} height={16} className="icon-flip-rtl">
      <path d="M15 6l-6 6 6 6" />
    </svg>
  );
}

export function IconDownload() {
  return (
    <svg {...base} width={16} height={16}>
      <path d="M12 4v11M7.5 10.5 12 15l4.5-4.5M5 14v5a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-5" />
    </svg>
  );
}

/** A spreadsheet file (the import template / the uploaded file). */
export function IconSheet({ size = 18 }: { size?: number }) {
  return (
    <svg {...base} width={size} height={size}>
      <path d="M7 3.5h7l4 4V20a.5.5 0 0 1-.5.5h-10A.5.5 0 0 1 7 20V3.5Z" />
      <path d="M14 3.5v4h4M9.5 11.5h6M9.5 14.5h6M9.5 17.5h6M12.5 11.5v6" />
    </svg>
  );
}

export function IconCheck() {
  return (
    <svg {...base} width={16} height={16}>
      <path d="M5 12.5l4.5 4.5L19 7.5" />
    </svg>
  );
}

export function IconAlert() {
  return (
    <svg {...base} width={16} height={16}>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M12 7.5v5.5M12 16.3v.2" />
    </svg>
  );
}

/** «مجموعات المتجر»: four tiles. */
export function IconCollections() {
  return (
    <svg {...base} width={16} height={16}>
      <rect x="4" y="4" width="7" height="7" rx="1.6" />
      <rect x="13" y="4" width="7" height="7" rx="1.6" />
      <rect x="4" y="13" width="7" height="7" rx="1.6" />
      <rect x="13" y="13" width="7" height="7" rx="1.6" />
    </svg>
  );
}

/** A drag handle (six dots). */
export function IconGrip() {
  return (
    <svg {...base} width={16} height={16} strokeWidth={2.6}>
      <path d="M9 6h.01M15 6h.01M9 12h.01M15 12h.01M9 18h.01M15 18h.01" />
    </svg>
  );
}

export function IconArrowUp() {
  return (
    <svg {...base} width={16} height={16}>
      <path d="M12 19V5M6 11l6-6 6 6" />
    </svg>
  );
}

export function IconArrowDown() {
  return (
    <svg {...base} width={16} height={16}>
      <path d="M12 5v14M6 13l6 6 6-6" />
    </svg>
  );
}

export function IconBell() {
  return (
    <svg {...base} width={18} height={18}>
      <path d="M6 16V11a6 6 0 1 1 12 0v5l1.5 2h-15L6 16ZM10 20.5a2.2 2.2 0 0 0 4 0" />
    </svg>
  );
}

export function IconImage() {
  return (
    <svg {...base} width={18} height={18}>
      <rect x="3.5" y="5" width="17" height="14" rx="2" />
      <circle cx="9" cy="10" r="1.7" />
      <path d="m20.5 16-5-5-8 8" />
    </svg>
  );
}
