"use client";

import { useEffect, useRef, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { useJob } from "@/lib/store";
import { useTypewriter } from "@/lib/useTypewriter";
import type {
  CodeRunResult,
  LiteratureFinding,
  ReviewerOutput,
} from "@/lib/types";

interface RoundData {
  skepticText: string;
  championText: string;
  skepticReview?: ReviewerOutput;
  championReview?: ReviewerOutput;
  deltaFromPrev?: number;
  literature?: LiteratureFinding[];
  code?: CodeRunResult[];
  converged?: boolean;
}

function scoresLine(scores: Record<string, number> | undefined) {
  if (!scores) return null;
  const entries = Object.entries(scores);
  if (!entries.length) return null;
  return (
    <div className="mt-2 grid grid-cols-2 gap-x-3 gap-y-1 font-mono text-[11px]">
      {entries.map(([k, v]) => (
        <div key={k} className="flex justify-between">
          <span style={{ color: "var(--color-text-muted)" }}>{k}</span>
          <span>{typeof v === "number" ? v.toFixed(1) : String(v)}</span>
        </div>
      ))}
    </div>
  );
}

function ReviewerColumn({
  label,
  variant,
  streamText,
  review,
}: {
  label: string;
  variant: "skeptic" | "champion";
  streamText: string;
  review: ReviewerOutput | undefined;
}) {
  const typed = useTypewriter(streamText);
  const typingDone = review != null;

  return (
    <div className="mb-[var(--space-4)]">
      <div className="flex items-center justify-between mb-1.5">
        <span className={`badge-${variant}`}>{label}</span>
        {review ? (
          <span
            className="font-mono text-[11px]"
            style={{ color: "var(--color-text-muted)" }}
          >
            {review.recommendation?.replace(/_/g, " ")}
          </span>
        ) : streamText ? (
          <span
            className="eyebrow inline-flex items-center gap-1"
            style={{ color: "var(--color-primary-strong)" }}
          >
            <span className="inline-block w-1.5 h-1.5 rounded-full bg-[color:var(--color-primary)] animate-pulse" />
            live
          </span>
        ) : (
          <span className="eyebrow">waiting</span>
        )}
      </div>

      <AnimatePresence mode="wait" initial={false}>
        {typingDone ? (
          <motion.div
            key="summary"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ duration: 0.25 }}
            className="text-[var(--text-sm)] leading-relaxed whitespace-pre-wrap"
          >
            {review!.summary}
          </motion.div>
        ) : streamText ? (
          <motion.pre
            key="stream"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.15 }}
            className="font-mono text-[11.5px] leading-[1.55] whitespace-pre-wrap break-words"
            style={{ color: "var(--color-text-muted)" }}
          >
            {typed}
            <span className="stream-cursor" />
          </motion.pre>
        ) : (
          <motion.div
            key="idle"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            className="text-[var(--text-sm)] italic"
            style={{ color: "var(--color-text-faint)" }}
          >
            queued
          </motion.div>
        )}
      </AnimatePresence>

      {review && (
        <>
          {variant === "skeptic" && review.weaknesses?.length ? (
            <ul className="mt-2 space-y-1 text-[12px]">
              {review.weaknesses.slice(0, 4).map((w, i) => (
                <li key={i} className="flex gap-2">
                  <span
                    className="mt-1.5 shrink-0 w-1 h-1 rounded-full"
                    style={{
                      background:
                        w.severity === "critical"
                          ? "var(--color-skeptic)"
                          : w.severity === "major"
                          ? "var(--color-warning)"
                          : "var(--color-text-faint)",
                    }}
                  />
                  <span>{w.issue}</span>
                </li>
              ))}
            </ul>
          ) : null}
          {variant === "champion" && review.strengths?.length ? (
            <ul className="mt-2 space-y-1 text-[12px]">
              {review.strengths.slice(0, 3).map((s, i) => (
                <li key={i} style={{ color: "var(--color-text-muted)" }}>
                  + {s}
                </li>
              ))}
            </ul>
          ) : null}
          {scoresLine(review.scores)}
        </>
      )}
    </div>
  );
}

function RoundBlock({
  r,
  rd,
  isLatest,
}: {
  r: number;
  rd: RoundData;
  isLatest: boolean;
}) {
  const deltaPct =
    rd.deltaFromPrev === undefined
      ? null
      : Math.round((1 - Math.min(Math.max(rd.deltaFromPrev, 0), 1)) * 100);

  return (
    <div className={isLatest ? "" : "opacity-60"}>
      <div className="flex items-center gap-2 mb-[var(--space-3)]">
        <span className="eyebrow">Round {r}</span>
        {isLatest && (
          <span
            className="eyebrow"
            style={{ color: "var(--color-primary-strong)" }}
          >
            · live
          </span>
        )}
        {deltaPct !== null && !isLatest && (
          <span
            className="eyebrow"
            style={{ color: "var(--color-text-faint)" }}
          >
            · {deltaPct}% overlap
          </span>
        )}
        {rd.converged && (
          <span
            className="eyebrow"
            style={{ color: "var(--color-champion)" }}
          >
            · converged
          </span>
        )}
        <div className="flex-1 tick-divider" />
      </div>

      <ReviewerColumn
        label="REVIEWER 1"
        variant="skeptic"
        streamText={rd.skepticText}
        review={rd.skepticReview}
      />
      <ReviewerColumn
        label="REVIEWER 2"
        variant="champion"
        streamText={rd.championText}
        review={rd.championReview}
      />

      {rd.literature && rd.literature.length > 0 && (
        <div className="mt-2 card-tight px-3 py-2 text-[var(--text-sm)]">
          <div className="eyebrow mb-1">
            Literature · {rd.literature.length} finding
            {rd.literature.length === 1 ? "" : "s"}
          </div>
          <ul className="space-y-1">
            {rd.literature.slice(0, 3).map((f, i) => (
              <li key={i} className="text-[12px] leading-snug">
                <span className="eyebrow mr-1">
                  {f.category.replace(/_/g, " ")}
                </span>
                {f.papers?.[0]?.title || f.claim}
              </li>
            ))}
          </ul>
        </div>
      )}

      {rd.code && rd.code.length > 0 && (
        <div className="mt-2 card-tight px-3 py-2 text-[var(--text-sm)]">
          <div className="eyebrow mb-1">
            Code · {rd.code.filter((c) => c.status === "passed").length}/
            {rd.code.length} passed
          </div>
          <ul className="space-y-1">
            {rd.code.slice(0, 3).map((c, i) => (
              <li key={i} className="font-mono text-[11px]">
                block {c.block_id} · {c.language} · {c.status}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

export function ReviewerStream() {
  const rounds = useJob((s) => s.rounds);
  const currentRound = useJob((s) => s.currentRound) || 1;
  const literatureAll = useJob((s) => s.literatureAll);
  const codeAll = useJob((s) => s.codeAll);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const followRef = useRef(true);

  const onScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    followRef.current = el.scrollTop + el.clientHeight >= el.scrollHeight - 40;
  };

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    if (followRef.current) el.scrollTop = el.scrollHeight;
  }, [rounds, currentRound, literatureAll.length, codeAll.length]);

  const roundNums = Object.keys(rounds)
    .map((n) => Number(n))
    .sort((a, b) => a - b);

  return (
    <div
      ref={scrollRef}
      onScroll={onScroll}
      className="h-full overflow-y-auto scroll-pane px-[var(--space-4)] py-[var(--space-3)]"
    >
      {roundNums.map((r, i) => (
        <div key={r} className={i > 0 ? "mt-[var(--space-5)]" : ""}>
          <RoundBlock r={r} rd={rounds[r]} isLatest={i === roundNums.length - 1} />
        </div>
      ))}
      {!roundNums.length && (
        <div
          className="h-full flex items-center justify-center text-center font-mono py-[var(--space-6)]"
          style={{ color: "var(--color-text-faint)" }}
        >
          <div>
            <div className="inline-block w-1.5 h-1.5 rounded-full bg-[color:var(--color-primary)] animate-pulse mb-2" />
            <div className="text-[var(--text-sm)]">booting reviewers…</div>
          </div>
        </div>
      )}
    </div>
  );
}
