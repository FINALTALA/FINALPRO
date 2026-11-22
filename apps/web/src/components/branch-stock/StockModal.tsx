"use client";

import { useEffect, useId, useRef, type ReactNode } from "react";

/** A real modal (native <dialog>): focus stays inside, Escape closes, the page behind is inert. */
export default function StockModal({
  title,
  onClose,
  busy,
  children,
  testId,
}: {
  title: string;
  onClose: () => void;
  busy: boolean;
  children: ReactNode;
  testId: string;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  useEffect(() => {
    const d = ref.current;
    if (d && !d.open) d.showModal();
    return () => {
      if (d?.open) d.close();
    };
  }, []);
  return (
    <dialog
      ref={ref}
      className="sk-dialog"
      aria-labelledby={titleId}
      data-testid={testId}
      onCancel={(e) => {
        e.preventDefault();
        if (!busy) onClose();
      }}
    >
      <h2 id={titleId} className="sk-dialog-title">{title}</h2>
      {children}
    </dialog>
  );
}
