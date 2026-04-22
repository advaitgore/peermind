"use client";

import { motion, AnimatePresence } from "framer-motion";
import type { Verdict } from "@/lib/types";

function recommendationColor(rec: string): string {
  const r = rec.toLowerCase();
  if (r.includes("strong_accept") || r === "accept") return "var(--color-champion)";
  if (r.includes("reject")) return "var(--color-skeptic)";
  if (r.includes("revision") || r.includes("border")) return "var(--color-warn)";
  return "var(--color-text)";
}

function prettyRec(r: string) {
  return r
    .split("_")
    .map((s) => s.charAt(0).toUpperCase() + s.slice(1))
    .join(" ");
}

export function VerdictCard({ verdict }: { verdict: Verdict | null }) {
  return (
    <AnimatePresence>
      {verdict && (
        <motion.div
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          className="card px-4 py-3"
        >
          <div className="text-[11px] font-mono uppercase tracking-wider text-[color:var(--color-text-dim)] mb-1">
            Verdict
          </div>
          <div
            className="text-xl font-semibold"
            style={{ color: recommendationColor(verdict.recommendation) }}
          >
            {prettyRec(verdict.recommendation)}
          </div>
          <div className="text-xs font-mono text-[color:var(--color-text-dim)] mt-0.5">
            Confidence {(verdict.confidence * 100).toFixed(0)}%
          </div>
          {verdict.one_line_verdict && (
            <div className="text-[13px] mt-2 text-[color:var(--color-text)]">
              {verdict.one_line_verdict}
            </div>
          )}
          {verdict.reviewer_recommendations && (
            <div className="mt-2 grid grid-cols-2 gap-2 text-[11px] font-mono">
              <div>
                <span className="badge badge-skeptic mr-1">S</span>
                {verdict.reviewer_recommendations.skeptic || "—"}
              </div>
              <div>
                <span className="badge badge-champion mr-1">C</span>
                {verdict.reviewer_recommendations.champion || "—"}
              </div>
            </div>
          )}
          {verdict.consensus_issues && verdict.consensus_issues.length > 0 && (
            <div className="mt-3">
              <div className="text-[11px] font-mono uppercase tracking-wider text-[color:var(--color-text-dim)] mb-1">
                Consensus issues
              </div>
              <ul className="text-[12px] space-y-1">
                {verdict.consensus_issues.slice(0, 4).map((ci, i) => (
                  <li key={i} className="flex items-start gap-2">
                    <span className="badge text-[10px]">{ci.severity}</span>
                    <span>{ci.issue}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </motion.div>
      )}
    </AnimatePresence>
  );
}
