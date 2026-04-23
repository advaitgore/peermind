import { useEffect, useRef, useState } from "react";

/**
 * Smooth a chunk-based stream into a character-by-character typewriter.
 *
 * The backend emits ``reviewer_token`` events whose text chunks vary from a
 * single character up to ~80 characters depending on the SDK. Rendering each
 * chunk instantly produces a stutter; rendering them char-by-char at a fixed
 * rate feels like a real typing stream.
 *
 * If `target` grows faster than we can catch up, we speed up so we never fall
 * more than ~400 characters behind. If the caller passes a *shrinking*
 * target (e.g. on reset), we jump to the new value immediately.
 */
export function useTypewriter(target: string, opts: { charsPerTick?: number; tickMs?: number } = {}): string {
  const { charsPerTick = 2, tickMs = 14 } = opts;
  const [displayed, setDisplayed] = useState("");
  const rafTimer = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    // Shrink or instant-sync: target got shorter than what we've displayed.
    if (target.length < displayed.length) {
      setDisplayed(target);
      return;
    }
    if (target.length === displayed.length) {
      return;
    }
    // If we're more than 400 chars behind, snap forward — no-one wants to
    // wait 30 seconds for the typewriter to catch up on a long stream.
    const lag = target.length - displayed.length;
    const step = lag > 400 ? Math.min(lag - 80, 200) : charsPerTick;

    if (rafTimer.current) clearInterval(rafTimer.current);
    rafTimer.current = setInterval(() => {
      setDisplayed((d) => {
        if (d.length >= target.length) {
          if (rafTimer.current) clearInterval(rafTimer.current);
          return target;
        }
        return target.slice(0, d.length + step);
      });
    }, tickMs);

    return () => {
      if (rafTimer.current) {
        clearInterval(rafTimer.current);
        rafTimer.current = null;
      }
    };
  }, [target, charsPerTick, tickMs, displayed.length]);

  return displayed;
}
