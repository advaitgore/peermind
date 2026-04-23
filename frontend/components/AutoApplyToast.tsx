"use client";

import { AnimatePresence, motion } from "framer-motion";
import { useJob } from "@/lib/store";

type Step = "locating" | "diffing" | "compiling" | "reloading" | "done";

const STEPS: Array<{ key: Step; label: string }> = [
  { key: "locating", label: "locating" },
  { key: "diffing", label: "diffing" },
  { key: "compiling", label: "compiling" },
  { key: "reloading", label: "reloading" },
];

function stepOrder(s: Step | undefined): number {
  if (!s) return -1;
  return STEPS.findIndex((x) => x.key === s);
}

export function AutoApplyToast({
  visible,
  index,
  total,
  description,
}: {
  visible: boolean;
  index: number;
  total: number;
  description: string;
}) {
  const apply = useJob((s) => s.applyProgress);
  const currentStep = apply?.step;
  const current = stepOrder(currentStep);

  return (
    <AnimatePresence>
      {visible && (
        <motion.div
          initial={{ opacity: 0, y: -20 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: -20 }}
          className="fixed top-16 left-1/2 -translate-x-1/2 z-50 card-tight px-[var(--space-4)] py-[var(--space-3)] shadow-lg min-w-[360px]"
          role="status"
          style={{ background: "var(--color-surface)" }}
        >
          <div className="flex items-center gap-3">
            <span
              className="inline-flex items-center justify-center w-5 h-5 rounded-full text-[11px] font-mono"
              style={{
                background: "var(--color-primary)",
                color: "var(--color-primary-fg)",
              }}
            >
              {index}
            </span>
            <div className="flex-1 min-w-0">
              <div className="eyebrow" style={{ color: "var(--color-text-muted)" }}>
                applying patch {index}/{total}
              </div>
              <div
                className="text-[var(--text-sm)] truncate"
                style={{ color: "var(--color-text)" }}
              >
                {description}
              </div>
            </div>
          </div>

          {/* 4-dot sub-timeline */}
          <div className="mt-[var(--space-3)] flex items-center gap-1">
            {STEPS.map((s, i) => {
              const isDone = current > i || currentStep === "done";
              const isActive = i === current && currentStep !== "done";
              return (
                <div key={s.key} className="flex items-center gap-1 flex-1">
                  <span
                    className="w-1.5 h-1.5 rounded-full shrink-0"
                    style={{
                      background: isDone
                        ? "var(--color-champion)"
                        : isActive
                        ? "var(--color-primary)"
                        : "var(--color-text-faint)",
                      opacity: isDone || isActive ? 1 : 0.4,
                      boxShadow: isActive
                        ? "0 0 0 3px rgba(79,152,163,0.25)"
                        : "none",
                      transition: "background 140ms ease, box-shadow 140ms ease",
                    }}
                  />
                  <span
                    className="font-mono text-[10px] tracking-wider"
                    style={{
                      color: isActive
                        ? "var(--color-primary-strong)"
                        : isDone
                        ? "var(--color-text-muted)"
                        : "var(--color-text-faint)",
                    }}
                  >
                    {s.label}
                  </span>
                  {i < STEPS.length - 1 && (
                    <span
                      className="flex-1 h-px"
                      style={{
                        background: isDone
                          ? "var(--color-champion)"
                          : "var(--color-border)",
                        opacity: isDone ? 0.5 : 1,
                      }}
                    />
                  )}
                </div>
              );
            })}
          </div>

          {apply?.detail && (
            <div
              className="mt-1.5 font-mono text-[10px]"
              style={{ color: "var(--color-text-faint)" }}
            >
              {apply.detail}
            </div>
          )}
        </motion.div>
      )}
    </AnimatePresence>
  );
}
