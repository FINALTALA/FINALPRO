// Minimal inline SVG icons for the auth pages (login/register/
// reset-password) only - no new dependency. The phone/lock/message/
// eye icons are plain, same-weight line icons built to match the
// sizing/positioning rules in auth-pages.module.css (.inputIcon,
// .toggleButton svg) - the reference's own HTML for those wasn't
// available, just its CSS. The logo star below IS the literal path
// from the reference; fill is left unset on the <path> itself so the
// module's `.logo svg { fill: white }` rule is what colours it,
// exactly as the reference stylesheet does it.

export function StarSparkleIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M12 2.5l1.55 7.95L21.5 12l-7.95 1.55L12 21.5l-1.55-7.95L2.5 12l7.95-1.55L12 2.5z" />
    </svg>
  );
}

export function PhoneIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <rect x="7" y="2.5" width="10" height="19" rx="2.2" stroke="currentColor" strokeWidth="1.6" />
      <path d="M10.5 18.3h3" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  );
}

export function LockIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <rect x="4.5" y="10.5" width="15" height="10" rx="2.4" stroke="currentColor" strokeWidth="1.6" />
      <path d="M8 10.5V7.8a4 4 0 0 1 8 0v2.7" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
      <circle cx="12" cy="15.3" r="1.5" fill="currentColor" />
    </svg>
  );
}

export function MessageCodeIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        d="M4 5.5h16a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1H9l-4.2 3.3a.5.5 0 0 1-.8-.4V16.5H4a1 1 0 0 1-1-1v-9a1 1 0 0 1 1-1Z"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinejoin="round"
      />
      <path d="M8 11h8" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  );
}

export function EyeIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        d="M1 12s4-7 11-7 11 7 11 7-4 7-11 7-11-7-11-7Z"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinejoin="round"
      />
      <circle cx="12" cy="12" r="3" stroke="currentColor" strokeWidth="1.6" />
    </svg>
  );
}

export function EyeOffIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="M3 3l18 18" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
      <path
        d="M10.6 5.2A11.6 11.6 0 0 1 12 5c7 0 11 7 11 7a14.7 14.7 0 0 1-3 3.6M6.6 6.6C3.8 8.4 1 12 1 12s4 7 11 7c1.4 0 2.7-.2 3.9-.6"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
