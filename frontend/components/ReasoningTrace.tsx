"use client";

import { useEffect, useRef, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { Brain, ChevronDown, ChevronRight } from "lucide-react";
import { useJob } from "@/lib/store";

/**
 * Live stream of Opus 4.7's extended-thinking trace during verdict synthesis.
 *
 * Hidden until the first `synthesis_thinking` token lands. Auto-expands while
 * the trace is streaming. Once `synthesis_thinking_done` fires we collapse to
 * a tidy "Reasoning (N tokens)" summary the user can re-open.
 */
export function ReasoningTrace() {
  const reasoning = useJob((s) => s.synthesisReasoning);
  const done = useJob((s) => s.synthesisReasoningDone);
  const verdict = useJob((s) => s.verdict);
  const bodyRef = useRef<HTMLDivElement | null>(null);

  // Collapsed state is user-controllable. We auto-expand on first token and
  // auto-collapse once thinking is done AND the verdict has landed — but only
  // if the user hasn't manually toggled since then.
  const [expanded, setExpanded] = useState(false);
  const userToggledRef = useRef(false);

  useEffect(() => {
    if (!reasoning) return;
    if (!userToggledRef.current) {
      if (!done) setExpanded(true);
      else if (verdict) setExpanded(false);
    }
  }, [reasoning, done, verdict]);

  // Autoscroll the trace as tokens arrive.
  useEffect(() => {
    if (expanded && bodyRef.current) {
      bodyRef.current.scrollTop = bodyRef.current.scrollHeight;
    }
  }, [reasoning, expanded]);

  if (!reasoning) return null;

  const wordCount = reasoning.trim().split(/\s+/).filter(Boolean).length;

  return (
    <div
      className="rounded-[var(--radius-md)] border"
      style={{
        background: "var(--color-surface-1)",
        borderColor: "var(--color-border)",
      }}
    >
      <button
        onClick={() => {
          userToggledRef.current = true;
          setExpanded((v) => !v);
        }}
        className="w-full flex items-center gap-2 px-[var(--space-3)] py-[var(--space-2)] text-left"
      >
        {expanded ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
        <Brain size={13} style={{ color: "var(--color-primary-strong)" }} />
        <span className="eyebrow">
          {done ? "Reasoning trace" : "Reasoning"}
        </span>
        <span
          className="ml-auto font-mono tabular-nums"
          style={{ fontSize: "var(--text-xs)", color: "var(--color-text-faint)" }}
        >
          {done ? `${wordCount} words` : "streaming…"}
        </span>
        {!done && (
          <span
            className="inline-block w-1.5 h-1.5 rounded-full"
            style={{ background: "var(--color-primary-strong)" }}
          >
            <motion.span
              animate={{ opacity: [0.4, 1, 0.4] }}
              transition={{ duration: 1.2, repeat: Infinity }}
              className="block w-full h-full rounded-full"
              style={{ background: "var(--color-primary-strong)" }}
            />
          </span>
        )}
      </button>

      <AnimatePresence initial={false}>
        {expanded && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.2 }}
            className="overflow-hidden"
          >
            <div
              ref={bodyRef}
              className="max-h-[220px] overflow-y-auto scroll-pane px-[var(--space-3)] pb-[var(--space-3)] pt-[var(--space-1)] font-mono whitespace-pre-wrap leading-relaxed"
              style={{
                fontSize: "var(--text-xs)",
                color: "var(--color-text-muted)",
                borderTop: "1px solid var(--color-border)",
              }}
            >
              {reasoning}
              {!done && (
                <motion.span
                  animate={{ opacity: [1, 0, 1] }}
                  transition={{ duration: 0.8, repeat: Infinity }}
                  className="inline-block w-[6px] h-[10px] ml-0.5 align-middle"
                  style={{ background: "var(--color-primary-strong)" }}
                />
              )}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
