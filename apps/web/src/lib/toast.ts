"use client";

/**
 * 2026-11-18: a small, temporary message at the top of the screen (a saved
 * collection, a published product with a note) - never inside the content,
 * never blurring what is behind it. Any page or component calls showToast();
 * the shell's <Toaster /> shows it (also inside the management frame).
 */
export type ToastTone = "success" | "warning" | "error";
export interface ToastMessage {
  id: number;
  text: string;
  tone: ToastTone;
  /** ms; a warning stays longer and can be closed by hand. */
  duration: number;
}

const EVENT = "finalpro:toast";
let next = 1;

export function showToast(text: string, tone: ToastTone = "success", duration?: number) {
  if (typeof window === "undefined") return;
  const message: ToastMessage = { id: next++, text, tone, duration: duration ?? (tone === "success" ? 3200 : 9000) };
  window.dispatchEvent(new CustomEvent<ToastMessage>(EVENT, { detail: message }));
}

export function onToast(handler: (m: ToastMessage) => void): () => void {
  const listener = (e: Event) => handler((e as CustomEvent<ToastMessage>).detail);
  window.addEventListener(EVENT, listener);
  return () => window.removeEventListener(EVENT, listener);
}
