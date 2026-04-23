"use client";

import { motion } from "framer-motion";
import type { Verdict } from "@/lib/types";
import { BACKEND_BASE } from "@/lib/api";
import { ExternalLink, Package, TrendingUp } from "lucide-react";

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
  jobId,
  critiqueDelta,
}: {
  verdict: Verdict | null;
  jobId?: string;
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

      {/* Export links — download project zip + review letter */}
      {jobId && (
        <div className="pt-[var(--space-2)] flex flex-col gap-1.5">
          <a
            href={`${BACKEND_BASE}/api/jobs/${jobId}/export.zip`}
            download
            className="btn-ghost inline-flex items-center gap-1.5 text-[var(--text-sm)] self-start"
            title="Downloads the project tree with applied patches + a review report, ready to drop into Overleaf"
          >
            <Package size={13} />
            <span>Download project (zip) for Overleaf</span>
          </a>
          <a
            href={`${BACKEND_BASE}/api/jobs/${jobId}/review-letter`}
            target="_blank"
            rel="noopener noreferrer"
            className="btn-ghost inline-flex items-center gap-1.5 text-[var(--text-sm)] self-start"
          >
            <ExternalLink size={13} />
            <span>Export full review letter</span>
          </a>
        </div>
      )}
    </motion.div>
  );
}
