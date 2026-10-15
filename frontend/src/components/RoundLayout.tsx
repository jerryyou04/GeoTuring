import React, { useEffect, useRef } from "react";
import type { ReactNode } from "react";
import type { Phase } from "../types";

export function RoundLayout({ phase, children }: { phase: Phase; children: ReactNode }) {
  const elementRef = useRef<HTMLElement | null>(null);
  const hasDecision = phase !== "chat" && phase !== "ended";

  useEffect(() => {
    if (!hasDecision) return;
    const panel = elementRef.current?.querySelector<HTMLElement>(".decisionPanel, .reveal");
    panel?.querySelector<HTMLElement>("h2")?.focus({ preventScroll: true });
    // A final guess can open while the mobile page is scrolled to the composer.
    // Bring the timed decision into view and leave the saved conversation below.
    if (window.matchMedia("(max-width: 820px)").matches) {
      panel?.scrollIntoView({ block: "start", behavior: "auto" });
    }
  }, [phase, hasDecision]);

  return <section ref={elementRef} className={`roundLayout ${hasDecision ? "hasDecision" : "chatOnly"}`} aria-label="Current round">{children}</section>;
}
