import Link from "next/link";
import type { ReactNode } from "react";

export function SkeletonGrid({ count = 8 }: { count?: number }) {
  return (
    <div className="product-grid" aria-busy="true" aria-label="جارٍ التحميل">
      {Array.from({ length: count }).map((_, i) => (
        <div key={i} className="skeleton skeleton-card" />
      ))}
    </div>
  );
}

export function EmptyState({
  title,
  message,
  actionHref,
  actionLabel,
  children,
}: {
  title: string;
  message?: string;
  actionHref?: string;
  actionLabel?: string;
  children?: ReactNode;
}) {
  return (
    <div className="empty-state">
      <h3>{title}</h3>
      {message && <p>{message}</p>}
      {actionHref && actionLabel && (
        <Link href={actionHref} className="button">
          {actionLabel}
        </Link>
      )}
      {children}
    </div>
  );
}

export function ErrorBanner({ message }: { message: string }) {
  return (
    <div className="error-banner" role="alert">
      {message}
    </div>
  );
}
