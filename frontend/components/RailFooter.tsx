"use client";

import { useState } from "react";
import { ExternalLink, Package, Sparkles } from "lucide-react";
import { BACKEND_BASE, startRebuttal } from "@/lib/api";
import { useJob } from "@/lib/store";

/**
 * Footer action bar above the ChatBar. Three compact buttons: zip export,
 * review-letter export, and the rebuttal trigger. Hidden until the verdict
 * lands — nothing to act on otherwise.
 */
export function RailFooter({ jobId }: { jobId: string }) {
  const verdict = useJob((s) => s.verdict);
  const rebuttalStreaming = useJob((s) => s.rebuttalStreaming);
  const rebuttalComplete = useJob((s) => s.rebuttalComplete);

  const [starting, setStarting] = useState(false);
  const [hint, setHint] = useState<string | null>(null);

  if (!verdict) return null;

  const rebuttalDisabled =
    starting || rebuttalStreaming || rebuttalComplete;

  const handleDraft = async () => {
    setHint(null);
    setStarting(true);
    useJob.setState({
      rebuttalText: "",
      rebuttalStreaming: true,
      rebuttalComplete: false,
    });
    try {
      await startRebuttal(jobId);
    } catch (e: any) {
      const msg = String(e?.message || "");
      // 400 = verdict not persisted yet (shouldn't happen post-fix, but
      // race-proof in case uvicorn is slow to commit).
      if (msg.includes("400")) {
        setHint("Verdict is still finalizing — retrying in 1.5s…");
        setTimeout(async () => {
          try {
            await startRebuttal(jobId);
            setHint(null);
          } catch (e2: any) {
            useJob.setState({ rebuttalStreaming: false });
            setHint(String(e2?.message || "Failed to start rebuttal"));
          }
        }, 1500);
      } else {
        useJob.setState({ rebuttalStreaming: false });
        setHint(msg || "Failed to start rebuttal");
      }
    } finally {
      setStarting(false);
    }
  };

  return (
    <div className="border-t border-[color:var(--color-border)] px-[var(--space-4)] py-[var(--space-3)]">
      <div className="flex flex-wrap items-center gap-1.5">
        <a
          href={`${BACKEND_BASE}/api/jobs/${jobId}/export.zip`}
          download
          className="btn-ghost inline-flex items-center gap-1.5 text-[var(--text-xs)]"
          title="Download the edited project tree + a review report, ready for Overleaf"
        >
          <Package size={12} />
          <span>Download zip</span>
        </a>
        <a
          href={`${BACKEND_BASE}/api/jobs/${jobId}/review-letter`}
          target="_blank"
          rel="noopener noreferrer"
          className="btn-ghost inline-flex items-center gap-1.5 text-[var(--text-xs)]"
        >
          <ExternalLink size={12} />
          <span>Review letter</span>
        </a>
        <button
          onClick={handleDraft}
          disabled={rebuttalDisabled}
          className="btn-primary inline-flex items-center gap-1.5 ml-auto"
          style={{ padding: "5px 12px", fontSize: "var(--text-xs)" }}
          title={
            rebuttalComplete
              ? "Already drafted — see the rebuttal message above"
              : "Draft a venue-style author response"
          }
        >
          <Sparkles size={12} />
          <span>
            {starting
              ? "Starting…"
              : rebuttalStreaming
              ? "Drafting…"
              : rebuttalComplete
              ? "Rebuttal drafted"
              : "Draft rebuttal"}
          </span>
        </button>
      </div>
      {hint && (
        <div
          className="mt-1.5 text-[11px] font-mono"
          style={{ color: "var(--color-text-faint)" }}
        >
          {hint}
        </div>
      )}
    </div>
  );
}
