"use client";

import { motion } from "framer-motion";
import type { Verdict } from "@/lib/types";
import { TrendingUp } from "lucide-react";

function prettyRec(r: string | undefined) {
  if (!r) return "—";
  return r.split("_").map((s) => s.charAt(0).toUpperCase() + s.slice(1)).join(" ");
}

function recColor(rec: string): string {
  const r = rec.toLowerCase();
  if (r.includes("strong_accept") || r === "accept") return "var(--color-champion)";
  if (r.includes("reject")) return "var(--color-skeptic)";
  return "var(--color-primary-strong)";
}

export function VerdictCard({
  verdict,
  critiqueDelta,
}: {
  verdict: Verdict | null;
  critiqueDelta?: number;
}) {
  if (!verdict) {
    return (
      <div className="card px-[var(--space-4)] py-[var(--space-5)] text-[var(--text-sm)]" style={{ color: "var(--color-text-muted)" }}>
        <div className="eyebrow mb-2">Awaiting verdict</div>
        <div>
          Reviewers and synthesis complete once the final round settles. The verdict and tiered
          action plan will appear here.
        </div>
      </div>
    );
  }

  const confPct = Math.round((verdict.confidence || 0) * 100);
  const deltaPct =
    critiqueDelta === undefined
      ? null
      : Math.round((1 - Math.min(Math.max(critiqueDelta, 0), 1)) * 100);
  const acceptance =
    typeof verdict.acceptance_probability === "number"
      ? Math.max(0, Math.min(1, verdict.acceptance_probability))
      : null;
  const acceptPct = acceptance === null ? null : Math.round(acceptance * 100);
  const acceptColor =
    acceptance === null
      ? "var(--color-primary-strong)"
      : acceptance >= 0.6
      ? "var(--color-champion)"
      : acceptance >= 0.35
      ? "var(--color-warning)"
      : "var(--color-skeptic)";

  return (
    <motion.div
      initial={{ opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.3 }}
      className="space-y-[var(--space-4)]"
    >
      {/* Metric chips */}
      <div className="flex flex-wrap gap-2">
        <span className="chip chip-accent">
          <TrendingUp size={11} strokeWidth={2} />
          {confPct}% confidence
        </span>
        {deltaPct !== null && (
          <span className="chip">
            Δ {deltaPct}% overlap
          </span>
        )}
      </div>

      {/* Verdict core */}
      <div>
        <div className="eyebrow mb-2">Verdict</div>
        <div
          className="font-display font-semibold leading-tight"
          style={{ fontSize: "var(--text-lg)", color: recColor(verdict.recommendation) }}
        >
          {prettyRec(verdict.recommendation)}
        </div>
        {verdict.one_line_verdict && (
          <p
            className="mt-[var(--space-2)] text-[var(--text-sm)] leading-relaxed"
            style={{ color: "var(--color-text-muted)" }}
          >
            {verdict.one_line_verdict}
          </p>
        )}
      </div>

      {/* Acceptance probability meter — Opus's calibrated estimate */}
      {acceptPct !== null && (
        <div>
          <div className="flex items-baseline justify-between mb-1.5">
            <span className="eyebrow">Acceptance probability</span>
            <span
              className="font-mono font-semibold tabular-nums"
              style={{ fontSize: "var(--text-sm)", color: acceptColor }}
            >
              {acceptPct}%
            </span>
          </div>
          <div
            className="relative h-1.5 rounded-full overflow-hidden"
            style={{ background: "var(--color-surface-2)" }}
            title={`Probability the paper would be accepted at the target venue as-is`}
          >
            <motion.div
              initial={{ width: 0 }}
              animate={{ width: `${acceptPct}%` }}
              transition={{ duration: 0.8, ease: "easeOut" }}
              className="absolute inset-y-0 left-0 rounded-full"
              style={{ background: acceptColor }}
            />
          </div>
        </div>
      )}

      {/* Reviewer split */}
      {verdict.reviewer_recommendations && (
        <div className="grid grid-cols-2 gap-2">
          <div className="px-3 py-2 rounded-md border border-[color:var(--color-border)] bg-[color:var(--color-surface-2)]">
            <div className="eyebrow" style={{ color: "var(--color-skeptic)" }}>Reviewer 1</div>
            <div className="text-[var(--text-sm)] mt-0.5">
              {prettyRec(verdict.reviewer_recommendations.skeptic)}
            </div>
          </div>
          <div className="px-3 py-2 rounded-md border border-[color:var(--color-border)] bg-[color:var(--color-surface-2)]">
            <div className="eyebrow" style={{ color: "var(--color-champion)" }}>Reviewer 2</div>
            <div className="text-[var(--text-sm)] mt-0.5">
              {prettyRec(verdict.reviewer_recommendations.champion)}
            </div>
          </div>
        </div>
      )}

      {/* Consensus issues */}
      {verdict.consensus_issues && verdict.consensus_issues.length > 0 && (
        <div>
          <div className="eyebrow mb-2">Consensus issues</div>
          <ul className="space-y-2">
            {verdict.consensus_issues.slice(0, 4).map((ci, i) => (
              <li key={i} className="flex gap-2 text-[var(--text-sm)] leading-snug">
                <span
                  className="mt-1.5 shrink-0 w-1 h-1 rounded-full"
                  style={{
                    background:
                      ci.severity === "critical"
                        ? "var(--color-skeptic)"
                        : ci.severity === "major"
                        ? "var(--color-warning)"
                        : "var(--color-text-faint)",
                  }}
                />
                <span>{ci.issue}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

    </motion.div>
  );
}
