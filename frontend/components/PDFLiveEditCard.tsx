"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { Check, Sparkles, X } from "lucide-react";
import { useJob } from "@/lib/store";

export function PDFLiveEditCard({ forceVisible }: { forceVisible?: boolean } = {}) {
  const activeFix = useJob((s) => s.activeFix);
  const fixState = useJob((s) => s.activeFixState);
  const applyProgress = useJob((s) => s.applyProgress);
  const [dismissed, setDismissed] = useState(false);

  // Reset dismissed whenever a NEW fix starts.
  useEffect(() => {
    if (fixState === "applying") setDismissed(false);
  }, [fixState]);

  const pair = useMemo(() => parseFirstDiffPair(activeFix?.diff || ""), [
    activeFix?.diff,
  ]);

  // Typewriter for the "+" line during applying phase.
  const [typed, setTyped] = useState("");
  const rafRef = useRef<number | null>(null);
  useEffect(() => {
    if (fixState !== "applying" || !pair?.added) {
      setTyped(fixState === "applied" ? (pair?.added || "") : "");
      return;
    }
    const full = pair.added;
    const startedAt = performance.now();
    const durationMs = Math.max(900, Math.min(3200, full.length * 28));
    const tick = (now: number) => {
      const t = Math.min(1, (now - startedAt) / durationMs);
      setTyped(full.slice(0, Math.floor(t * full.length)));
      if (t < 1) rafRef.current = requestAnimationFrame(tick);
    };
    rafRef.current = requestAnimationFrame(tick);
    return () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
    };
  }, [fixState, pair?.added]); // eslint-disable-line react-hooks/exhaustive-deps

  const step = applyProgress?.step;
  const stepLabel = step
    ? ({ locating: "Locating", diffing: "Editing", compiling: "Recompiling",
         reloading: "Loading preview", done: "Done" } as const)[step]
    : "Starting";

  const visible = forceVisible || (Boolean(activeFix) && !dismissed);

  return (
    <AnimatePresence>
      {visible && (
        <motion.div
          key="pdf-live-edit-card"
          initial={{ opacity: 0, x: 12, y: -4 }}
          animate={{ opacity: 1, x: 0, y: 0 }}
          exit={{ opacity: 0, y: -4 }}
          transition={{ duration: 0.22, ease: "easeOut" }}
          className={forceVisible ? "" : "absolute top-[52px] right-4 z-10"}
          style={{ width: 320, pointerEvents: "auto" }}
        >
          <AnimatePresence mode="wait">
            {fixState === "applied" ? (
              <motion.div
                key="applied"
                initial={{ opacity: 0, scale: 0.97 }}
                animate={{ opacity: 1, scale: 1 }}
                exit={{ opacity: 0 }}
                transition={{ duration: 0.2 }}
                className="rounded-[var(--radius-md)] border px-[var(--space-3)] py-[var(--space-3)] space-y-[var(--space-2)]"
                style={{
                  background: "var(--color-surface-3)",
                  borderColor: "var(--color-champion)",
                  boxShadow: "var(--shadow-lg)",
                }}
              >
                <div className="flex items-center justify-between">
                  <span
                    className="eyebrow inline-flex items-center gap-1.5"
                    style={{ color: "var(--color-champion)" }}
                  >
                    <Check size={11} />
                    Edit applied
                  </span>
                  <button
                    onClick={() => setDismissed(true)}
                    className="icon-btn"
                    style={{ width: 18, height: 18 }}
                    aria-label="dismiss"
                  >
                    <X size={11} />
                  </button>
                </div>
                {pair && (
                  <div className="space-y-1 font-mono text-[11px] leading-relaxed">
                    {pair.removed && (
                      <div
                        className="truncate"
                        style={{
                          color: "var(--color-text-faint)",
                          textDecoration: "line-through",
                        }}
                        title={pair.removed}
                      >
                        − {pair.removed}
                      </div>
                    )}
                    {pair.added && (
                      <div style={{ color: "var(--color-champion)" }}>
                        + {pair.added}
                      </div>
                    )}
                  </div>
                )}
              </motion.div>
            ) : (
              <motion.div
                key="applying"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                transition={{ duration: 0.18 }}
                className="rounded-[var(--radius-md)] border px-[var(--space-3)] py-[var(--space-3)] space-y-[var(--space-2)]"
                style={{
                  background: "var(--color-surface-3)",
                  borderColor: "var(--color-primary-strong)",
                  boxShadow: "var(--shadow-lg)",
                }}
                aria-live="polite"
              >
                <div
                  className="flex items-center gap-1.5 eyebrow"
                  style={{ color: "var(--color-primary-strong)" }}
                >
                  <Sparkles size={11} />
                  <span>Editing main.tex</span>
                  <span className="ml-auto" style={{ color: "var(--color-text-faint)" }}>
                    {stepLabel}
                  </span>
                </div>
                {pair && (
                  <div className="space-y-1 font-mono text-[11px] leading-relaxed">
                    {pair.removed && (
                      <div
                        className="truncate"
                        style={{ color: "var(--color-text-faint)", textDecoration: "line-through" }}
                        title={pair.removed}
                      >
                        − {pair.removed}
                      </div>
                    )}
                    <div style={{ color: "var(--color-text)" }}>
                      <span style={{ color: "var(--color-champion)" }}>+ </span>
                      {typed}
                      {typed.length < (pair.added?.length ?? 0) && (
                        <motion.span
                          animate={{ opacity: [1, 0, 1] }}
                          transition={{ duration: 0.8, repeat: Infinity }}
                          className="inline-block w-[5px] h-[10px] ml-0.5 align-middle"
                          style={{ background: "var(--color-primary-strong)" }}
                        />
                      )}
                    </div>
                  </div>
                )}
                <div className="flex items-center gap-1">
                  {(["locating", "diffing", "compiling", "reloading"] as const).map((s, i) => {
                    const order = ["locating", "diffing", "compiling", "reloading"];
                    const cur = step ? order.indexOf(step) : -1;
                    const me = order.indexOf(s);
                    const dotState = cur < 0 || me > cur ? "pending" : me === cur ? "active" : "done";
                    return (
                      <span
                        key={s}
                        className="inline-block rounded-full"
                        style={{
                          width: 6, height: 6,
                          background:
                            dotState === "done" ? "var(--color-champion)"
                            : dotState === "active" ? "var(--color-primary-strong)"
                            : "var(--color-border-strong)",
                        }}
                      />
                    );
                  })}
                </div>
              </motion.div>
            )}
          </AnimatePresence>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

function parseFirstDiffPair(diff: string): { removed: string; added: string } | null {
  if (!diff) return null;
  const lines = diff.split(/\r?\n/);
  let removed = "", added = "";
  for (const raw of lines) {
    if (raw.startsWith("---") || raw.startsWith("+++") || raw.startsWith("@@")) continue;
    if (!removed && raw.startsWith("-") && !raw.startsWith("---")) removed = raw.slice(1).trim();
    else if (!added && raw.startsWith("+") && !raw.startsWith("+++")) added = raw.slice(1).trim();
    if (removed && added) break;
  }
  if (!removed && !added) return null;
  return { removed, added };
}
