"use client";

import { useEffect } from "react";

/**
 * Filter out benign console noise from third-party libraries that's
 * harmless and only shows up because Next.js's dev overlay catches every
 * console.error.
 *
 * - `AbortException: TextLayer task cancelled` — react-pdf cancels in-flight
 *   text-layer tasks when a page unmounts mid-render (every cross-fade).
 * - `InvalidPDFException: Invalid PDF structure` — react-pdf logs this
 *   transiently while a freshly compiled PDF is still being flushed to
 *   disk on the backend. The component's onLoadError already surfaces a
 *   visible "compile error" chip when it actually matters.
 */
const SUPPRESSED_PATTERNS = [
  "TextLayer task cancelled",
  "Invalid PDF structure",
  "InvalidPDFException",
];

export function ConsoleNoiseSuppressor() {
  useEffect(() => {
    const original = console.error;
    console.error = (...args: unknown[]) => {
      const first = args[0];
      const msg =
        typeof first === "string"
          ? first
          : (first as { message?: string })?.message || String(first);
      for (const pat of SUPPRESSED_PATTERNS) {
        if (msg.includes(pat)) return;
      }
      original.apply(console, args as Parameters<typeof console.error>);
    };
    return () => {
      console.error = original;
    };
  }, []);
  return null;
}
