"use client";

import type { ImgHTMLAttributes, SyntheticEvent } from "react";
import { useState } from "react";

// A local, bundled asset - never a remote URL - so the fallback itself
// can never be the thing that fails to load.
const PLACEHOLDER_SRC = "/images/placeholder.svg";

interface SafeImageProps extends Omit<ImgHTMLAttributes<HTMLImageElement>, "alt" | "src" | "onError"> {
  src: string | null | undefined;
  /** Required: a real description of what this image shows, never "". */
  alt: string;
}

/**
 * Sprint 17b: a drop-in `<img>` replacement used everywhere the
 * frontend shows a vendor/store-supplied image URL (product photos,
 * store logos, etc.) that may be missing or may fail to load. Falls
 * back to a local placeholder asset exactly once - the error handler
 * clears itself (`currentTarget.onerror = null`) before swapping the
 * src, so even a broken placeholder can never re-trigger the handler
 * and loop.
 */
export default function SafeImage({ src, alt, ...rest }: SafeImageProps) {
  const [failed, setFailed] = useState(false);

  function handleError(e: SyntheticEvent<HTMLImageElement>) {
    e.currentTarget.onerror = null;
    setFailed(true);
  }

  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img {...rest} src={!src || failed ? PLACEHOLDER_SRC : src} alt={alt} onError={handleError} />
  );
}
