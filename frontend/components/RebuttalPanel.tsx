"use client";

import { useEffect, useRef, useState } from "react";
import { motion } from "framer-motion";
import { Copy, ExternalLink, FileText, MessageSquareQuote } from "lucide-react";
import { useJob } from "@/lib/store";
import { fetchExistingRebuttal, rebuttalLetterUrl } from "@/lib/api";

/**
 * Rebuttal Co-Pilot panel — embedded inline inside the conversation rail
 * as the body of a narrator message once the user hits "Draft rebuttal"
 * from the RailFooter. Tokens stream into `rebuttalText` via the shared
 * SSE channel. If the backend already has a persisted draft for this job
 * we restore it on mount.
 */
export function RebuttalPanel({ jobId }: { jobId: string }) {
  const text = useJob((s) => s.rebuttalText);
  const streaming = useJob((s) => s.rebuttalStreaming);
  const complete = useJob((s) => s.rebuttalComplete);

  const [copyState, setCopyState] = useState<"idle" | "copied">("idle");
  const bodyRef = useRef<HTMLDivElement | null>(null);

  // Restore any persisted draft on mount so a page refresh keeps the text.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const existing = await fetchExistingRebuttal(jobId);
        if (cancelled || !existing) return;
        if (!useJob.getState().rebuttalText) {
          useJob.setState({
            rebuttalText: existing.text,
            rebuttalComplete: true,
            rebuttalStreaming: false,
          });
        }
      } catch {
        /* 404 is expected until one has been drafted */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [jobId]);

  useEffect(() => {
    if (streaming && bodyRef.current) {
      bodyRef.current.scrollTop = bodyRef.current.scrollHeight;
    }
  }, [text, streaming]);

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopyState("copied");
      setTimeout(() => setCopyState("idle"), 1400);
    } catch {
      /* ignore */
    }
  };

  const hasContent = text.length > 0;
  if (!hasContent && !streaming) return null;

  const wordCount = text.trim().split(/\s+/).filter(Boolean).length;

  return (
    <div className="space-y-[var(--space-2)]">
      <div
        className="flex items-center gap-2 text-[11px] font-mono"
        style={{ color: "var(--color-text-faint)" }}
      >
        <MessageSquareQuote size={11} style={{ color: "var(--color-primary-strong)" }} />
        <span className="eyebrow" style={{ color: "var(--color-primary-strong)" }}>
          Rebuttal draft
        </span>
        <span className="ml-auto tabular-nums">
          {streaming ? `${wordCount} words · streaming…` : `${wordCount} words`}
        </span>
      </div>

      <div
        ref={bodyRef}
        className="max-h-[360px] overflow-y-auto scroll-pane whitespace-pre-wrap leading-relaxed rounded-sm"
        style={{
          fontSize: "var(--text-sm)",
          color: "var(--color-text)",
          background: "var(--color-surface-2)",
          padding: "var(--space-3)",
          border: "1px solid var(--color-border)",
        }}
      >
        {text}
        {streaming && (
          <motion.span
            animate={{ opacity: [1, 0, 1] }}
            transition={{ duration: 0.8, repeat: Infinity }}
            className="inline-block w-[6px] h-[12px] ml-0.5 align-middle"
            style={{ background: "var(--color-primary-strong)" }}
          />
        )}
      </div>

      <div className="flex items-center gap-1.5 flex-wrap">
        <button
          onClick={handleCopy}
          className="btn-ghost inline-flex items-center gap-1 text-[var(--text-xs)]"
          disabled={!complete && !streaming}
        >
          <Copy size={11} />
          <span>{copyState === "copied" ? "Copied" : "Copy"}</span>
        </button>
        <a
          href={rebuttalLetterUrl(jobId)}
          target="_blank"
          rel="noopener noreferrer"
          className="btn-ghost inline-flex items-center gap-1 text-[var(--text-xs)]"
        >
          <FileText size={11} />
          <span>Open as letter</span>
          <ExternalLink size={10} />
        </a>
      </div>
    </div>
  );
}
