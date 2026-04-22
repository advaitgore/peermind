"use client";

import { useEffect, useRef } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { useJob } from "@/lib/store";

function scoresLine(scores: Record<string, number> | undefined) {
  if (!scores) return null;
  const entries = Object.entries(scores);
  if (!entries.length) return null;
  return (
    <div className="mt-2 grid grid-cols-2 gap-x-3 gap-y-1 font-mono text-[11px]">
      {entries.map(([k, v]) => (
        <div key={k} className="flex justify-between">
          <span className="text-[color:var(--color-text-dim)]">{k}</span>
          <span>{typeof v === "number" ? v.toFixed(1) : String(v)}</span>
        </div>
      ))}
    </div>
  );
}

function cleanStreamText(text: string): string {
  // The reviewer emits JSON-only per its skill contract. To avoid showing raw
  // JSON to the user we fall back to stripping {} and "" around the content so
  // they see prose-ish output.
  if (!text) return "";
  const trimmed = text.trim();
  if (trimmed.startsWith("{") || trimmed.startsWith("```")) {
    // The model is mid-JSON; show a loading dashes while it writes.
    return "…analyzing";
  }
  return text;
}

export function ReviewerStream() {
  const rounds = useJob((s) => s.rounds);
  const currentRound = useJob((s) => s.currentRound) || 1;
  const literatureAll = useJob((s) => s.literatureAll);
  const codeAll = useJob((s) => s.codeAll);
  const scrollRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!scrollRef.current) return;
    scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [rounds, currentRound, literatureAll.length, codeAll.length]);

  const roundNums = Object.keys(rounds)
    .map((n) => Number(n))
    .sort((a, b) => a - b);

  return (
    <div ref={scrollRef} className="h-full overflow-y-auto scroll-pane px-3 py-3">
      {roundNums.map((r) => {
        const rd = rounds[r];
        return (
          <div key={r} className="mb-5">
            <div className="text-[11px] font-mono uppercase tracking-widest text-[color:var(--color-text-faint)] mb-2">
              — Round {r} —
            </div>

            {/* Skeptic */}
            <div className="mb-4">
              <div className="flex items-center justify-between mb-1.5">
                <span className="badge badge-skeptic">SKEPTIC</span>
                {rd.skepticReview && (
                  <span className="text-[11px] font-mono text-[color:var(--color-text-dim)]">
                    {rd.skepticReview.recommendation}
                  </span>
                )}
              </div>
              <div className="text-[13px] leading-relaxed whitespace-pre-wrap text-[color:var(--color-text)]">
                {rd.skepticReview?.summary || cleanStreamText(rd.skepticText)}
                {!rd.skepticReview && rd.skepticText && <span className="stream-cursor" />}
              </div>
              {rd.skepticReview && (
                <>
                  {rd.skepticReview.weaknesses?.length ? (
                    <ul className="mt-2 space-y-1 text-[12px]">
                      {rd.skepticReview.weaknesses.slice(0, 5).map((w, i) => (
                        <li key={i} className="flex gap-2">
                          <span
                            className={`badge text-[10px] ${
                              w.severity === "critical"
                                ? "badge-skeptic"
                                : w.severity === "major"
                                ? "bg-[color:var(--color-surface-2)]"
                                : ""
                            }`}
                          >
                            {w.severity}
                          </span>
                          <span>{w.issue}</span>
                        </li>
                      ))}
                    </ul>
                  ) : null}
                  {scoresLine(rd.skepticReview.scores)}
                </>
              )}
            </div>

            {/* Champion */}
            <div className="mb-2">
              <div className="flex items-center justify-between mb-1.5">
                <span className="badge badge-champion">CHAMPION</span>
                {rd.championReview && (
                  <span className="text-[11px] font-mono text-[color:var(--color-text-dim)]">
                    {rd.championReview.recommendation}
                  </span>
                )}
              </div>
              <div className="text-[13px] leading-relaxed whitespace-pre-wrap">
                {rd.championReview?.summary || cleanStreamText(rd.championText)}
                {!rd.championReview && rd.championText && <span className="stream-cursor" />}
              </div>
              {rd.championReview && (
                <>
                  {rd.championReview.strengths?.length ? (
                    <ul className="mt-2 space-y-1 text-[12px]">
                      {rd.championReview.strengths.slice(0, 4).map((s, i) => (
                        <li key={i}>+ {s}</li>
                      ))}
                    </ul>
                  ) : null}
                  {scoresLine(rd.championReview.scores)}
                </>
              )}
            </div>

            {/* Literature banner */}
            <AnimatePresence>
              {rd.literature && rd.literature.length > 0 && (
                <motion.div
                  initial={{ opacity: 0, y: 4 }}
                  animate={{ opacity: 1, y: 0 }}
                  className="card-tight mt-2 px-3 py-2 text-[12px]"
                >
                  <div className="font-mono text-[11px] uppercase tracking-wider text-[color:var(--color-text-dim)] mb-1">
                    📚 Literature found — context updated for next round
                  </div>
                  <ul className="space-y-1">
                    {rd.literature.slice(0, 4).map((f, i) => (
                      <li key={i} className="text-[12px]">
                        <span className="font-mono text-[10px] uppercase tracking-wider text-[color:var(--color-text-dim)] mr-1">
                          {f.category.replace(/_/g, " ")}:
                        </span>
                        {f.papers?.[0]?.title || f.claim}
                      </li>
                    ))}
                  </ul>
                </motion.div>
              )}
            </AnimatePresence>

            {/* Code runs banner */}
            <AnimatePresence>
              {rd.code && rd.code.length > 0 && (
                <motion.div
                  initial={{ opacity: 0, y: 4 }}
                  animate={{ opacity: 1, y: 0 }}
                  className="card-tight mt-2 px-3 py-2 text-[12px]"
                >
                  <div className="font-mono text-[11px] uppercase tracking-wider text-[color:var(--color-text-dim)] mb-1">
                    ⚙ Code executed — {rd.code.filter((c) => c.status === "passed").length}/{rd.code.length} passed
                  </div>
                  <ul className="space-y-1">
                    {rd.code.slice(0, 3).map((c, i) => (
                      <li key={i} className="font-mono text-[11px]">
                        block {c.block_id} · {c.language} · {c.status}
                      </li>
                    ))}
                  </ul>
                </motion.div>
              )}
            </AnimatePresence>

            {rd.converged && (
              <div className="mt-2 text-[11px] font-mono uppercase tracking-wider text-[color:var(--color-primary)]">
                ✓ Reviews converged
              </div>
            )}
          </div>
        );
      })}
      {!roundNums.length && (
        <div className="h-full flex items-center justify-center text-[12px] text-[color:var(--color-text-faint)] font-mono">
          waiting for agents to start…
        </div>
      )}
    </div>
  );
}
