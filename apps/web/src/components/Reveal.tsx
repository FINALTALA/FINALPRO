"use client";

import { type HTMLAttributes, type ReactNode } from "react";

type RevealProps = HTMLAttributes<HTMLDivElement> & {
  children?: ReactNode;
};

// Calm scroll-in reveal for storefront content sections. Not for
// Preview fallback: the layout remains identical when the optional GSAP
// dependency is unavailable. The production motion component can be restored
// once dependencies are installed in the target environment.
export default function Reveal({ children, ...props }: RevealProps) {
  return <div {...props}>{children}</div>;
}

