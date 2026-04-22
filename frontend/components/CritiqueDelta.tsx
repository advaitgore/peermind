"use client";

import { motion } from "framer-motion";

export function CritiqueDelta({ delta }: { delta: number | undefined }) {
  if (delta === undefined || Number.isNaN(delta)) return null;
  const pct = Math.round((1 - Math.min(Math.max(delta, 0), 1)) * 100);
  const arrow = delta < 0.3 ? "↓" : delta > 0.7 ? "↑" : "→";
  return (
    <motion.div
      initial={{ opacity: 0, y: -4 }}
      animate={{ opacity: 1, y: 0 }}
      className="flex items-center gap-2 text-xs font-mono uppercase tracking-wider text-[color:var(--color-text-dim)]"
      title="Jaccard-style similarity on reviewers' key claims vs. the previous round"
    >
      <span>Δ critique</span>
      <span className="text-[color:var(--color-text)]">
        {arrow} {(delta * 100).toFixed(0)}%
      </span>
      <div className="w-16 h-1.5 bg-[color:var(--color-border)] rounded">
        <div
          className="h-full bg-[color:var(--color-primary)] rounded"
          style={{ width: `${pct}%` }}
        />
      </div>
      <span className="text-[color:var(--color-text-faint)]">{pct}% overlap</span>
    </motion.div>
  );
}
