"use client";

import { useEffect, useRef, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { ArrowRight, Check, MapPin, Wand2, X } from "lucide-react";
import { useJob } from "@/lib/store";
import type { ActionPlanHandlers } from "./ActionPlan";
import { stripLatex } from "@/lib/latex";

/** Extract a scrollable reference from an issue's text — "Table 3",
 *  "Figure 2", "Section 5.4", or a bare "5.4" — so we can search the
 *  PDF text layer instead of guessing from page_hint arithmetic. */
function extractSectionRef(text: string): string | null {
  if (!text) return null;
  // Named table/figure: "Table 3", "Figure 2", "Fig. 2"
  const tableMatch = text.match(/\b(table|figure|fig\.?)\s+(\d+)\b/i);
  if (tableMatch) return `${tableMatch[1]} ${tableMatch[2]}`.toLowerCase();
  // Section reference: "Section 5.4", "Sec. 3.2", "§ 2.1", standalone "5.4"
  const secMatch =
    text.match(/(?:section|sec\.?|§)\s*([\d]+\.[\d]+(?:\.[\d]+)?)/i) ||
    text.match(/\b([\d]+\.[\d]+(?:\.[\d]+)?)\b(?!\s*%)/i);
  return secMatch ? secMatch[1] : null;
}

const SEVERITY_COLOR: Record<string, string> = {
  critical: "var(--color-skeptic)",
  major: "var(--color-warning)",
  minor: "var(--color-text-muted)",
};

/** Shape used by the unified walkthrough; built by ConversationRail. */
export interface GuideItem {
  id: string;
  title: string;
  severity: "critical" | "major" | "minor";
  source: "auto" | "author";
  diff?: string;
  description?: string;
  category?: string;
  claim?: string;
  evidence?: string;
  suggested_action?: string;
  page_hint?: number | null;
  tex_line_hint?: number | null;
  patch_id?: string; // present when source === "auto"
  applied?: boolean;
}

export function GuidedActionPlan({
  item,
  index,
  total,
  handlers,
  onAdvance,
  onShowList,
}: {
  item: GuideItem;
  index: number;
  total: number;
  handlers: ActionPlanHandlers;
  onAdvance: () => void;
  onShowList: () => void;
}) {
  const [applying, setApplying] = useState(false);
  const canFixNow = Boolean(item.diff);
  const severityColor = SEVERITY_COLOR[item.severity] || SEVERITY_COLOR.minor;

  // Subscribe to the apply sub-timeline for THIS item specifically. Other
  // items' apply progress is ignored so the timeline doesn't ghost across
  // steps.
  const applyProgress = useJob((s) => {
    if (!s.applyProgress) return null;
    // Auto-apply patches have a known patch_id — match precisely.
    // Author-required items use applyAdhocPatch which mints a fresh
    // "ah_..." id at apply time that we can't predict, so when item has
    // no patch_id, accept any active progress (only one apply at a time).
    if (!item.patch_id) return s.applyProgress;
    return s.applyProgress.patchId === item.id ||
      s.applyProgress.patchId === item.patch_id
      ? s.applyProgress
      : null;
  });
  const lastCompileError = useJob((s) => s.lastCompileError);

  // Auto-scroll on mount / item change. Try section-text search first
  // (most reliable), fall back to page_hint estimate.
  useEffect(() => {
    const sectionRef =
      extractSectionRef(item.claim || "") ||
      extractSectionRef(item.title || "");
    if (sectionRef && handlers.onScrollToText) {
      const found = handlers.onScrollToText(sectionRef);
      if (found) return; // text layer found the section — done
    }
    // Fallback: page_hint-based scroll (less precise).
    handlers.onZoomTo?.(item.page_hint ?? null, item.tex_line_hint ?? null);
  }, [item.id]); // eslint-disable-line react-hooks/exhaustive-deps

  // When this item's patch finishes applying, advance to the next after a
  // short beat so the user sees the ✓.
  const advancedRef = useRef(false);
  useEffect(() => {
    if (!applying) return;
    if (applyProgress?.step === "done" && !advancedRef.current) {
      advancedRef.current = true;
      const t = setTimeout(() => {
        setApplying(false);
        onAdvance();
      }, 900);
      return () => clearTimeout(t);
    }
  }, [applying, applyProgress?.step, onAdvance]);

  const runFix = async () => {
    if (!handlers.onFixNow || !canFixNow) return;
    advancedRef.current = false;
    setApplying(true);
    try {
      await handlers.onFixNow(item);
    } catch (e) {
      setApplying(false);
    }
  };

  return (
    <motion.div
      key={item.id}
      initial={{ opacity: 0, y: 4 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.22 }}
      className="space-y-[var(--space-3)]"
    >
      <div className="flex items-center justify-between">
        <span
          className="eyebrow inline-flex items-center gap-2"
          style={{ color: "var(--color-text-faint)" }}
        >
          <span
            className="w-1.5 h-1.5 rounded-full"
            style={{ background: severityColor }}
          />
          Issue {index + 1} of {total} · {item.severity}
          {item.page_hint && (
            <span
              className="inline-flex items-center gap-0.5 font-mono"
              style={{ fontSize: "11px" }}
            >
              <MapPin size={10} />
              p.{item.page_hint}
            </span>
          )}
          <span
            className="font-mono"
            style={{
              fontSize: "10px",
              color:
                item.source === "auto"
                  ? "var(--color-primary-strong)"
                  : "var(--color-text-faint)",
              letterSpacing: "0.08em",
              textTransform: "uppercase",
            }}
          >
            · {item.source === "auto" ? "auto-patch" : "needs author"}
          </span>
        </span>
        <button
          onClick={onShowList}
          className="btn-ghost text-[var(--text-xs)]"
          title="Show all issues as a list"
        >
          Show all
        </button>
      </div>

      <div
        className="font-display font-semibold leading-snug"
        style={{ fontSize: "var(--text-md)", color: "var(--color-text)" }}
      >
        {stripLatex(item.title)}
      </div>

      {(item.claim || item.evidence || item.suggested_action) && (
        <div
          className="space-y-1.5 text-[var(--text-sm)] leading-relaxed"
          style={{ color: "var(--color-text-muted)" }}
        >
          {item.claim && (
            <div>
              <span className="eyebrow mr-1.5">claim</span>
              {stripLatex(item.claim || "")}
            </div>
          )}
          {item.evidence && (
            <div>
              <span className="eyebrow mr-1.5">evidence</span>
              {stripLatex(item.evidence || "")}
            </div>
          )}
          {item.suggested_action && (
            <div style={{ color: "var(--color-text)" }}>
              <span className="eyebrow mr-1.5">do</span>
              {stripLatex(item.suggested_action || "")}
            </div>
          )}
        </div>
      )}

      {canFixNow && item.description && (
        <div
          className="px-2.5 py-2 rounded-sm text-[var(--text-sm)]"
          style={{
            background: "var(--color-primary-highlight)",
            borderLeft: "2px solid var(--color-primary)",
            color: "var(--color-text)",
          }}
        >
          <span
            className="eyebrow mr-1.5"
            style={{ color: "var(--color-primary-strong)" }}
          >
            fix preview
          </span>
          {item.description}
        </div>
      )}

      <AnimatePresence mode="wait">
        {applying ? (
          <motion.div
            key="timeline"
            initial={{ opacity: 0, y: 4 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.2 }}
          >
            <LiveEditTimeline
              progress={applyProgress?.step ?? "locating"}
              detail={applyProgress?.detail}
              errored={Boolean(lastCompileError)}
              onSkip={() => {
                setApplying(false);
                onAdvance();
              }}
              onRetry={runFix}
            />
          </motion.div>
        ) : item.applied ? (
          <motion.div
            key="applied"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            className="flex items-center gap-2 pt-1"
          >
            <span
              className="chip inline-flex items-center gap-1"
              style={{
                color: "var(--color-champion)",
                borderColor: "var(--color-champion)",
              }}
            >
              <Check size={11} />
              applied
            </span>
            <button
              onClick={onAdvance}
              className="btn-ghost inline-flex items-center gap-1 ml-auto text-[var(--text-xs)]"
            >
              {index + 1 >= total ? (
                <>
                  Finish <Check size={11} />
                </>
              ) : (
                <>
                  Next issue <ArrowRight size={11} />
                </>
              )}
            </button>
          </motion.div>
        ) : canFixNow ? (
          <motion.div
            key="confirm"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            className="space-y-2 pt-1"
          >
            <div
              className="text-[var(--text-sm)]"
              style={{ color: "var(--color-text)" }}
            >
              Would you like me to make this change?
            </div>
            <div className="flex flex-wrap items-center gap-1.5">
              <button
                onClick={runFix}
                disabled={applying}
                className="btn btn-primary inline-flex items-center gap-1.5"
                style={{ padding: "5px 12px", fontSize: "var(--text-xs)" }}
              >
                <Wand2 size={11} />
                Yes, apply it
              </button>
              <button
                onClick={onAdvance}
                className="btn inline-flex items-center gap-1.5"
                style={{ padding: "5px 12px", fontSize: "var(--text-xs)" }}
              >
                Skip for now
                <ArrowRight size={11} />
              </button>
            </div>
          </motion.div>
        ) : (
          <motion.div
            key="author-only"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            className="space-y-2 pt-1"
          >
            <div
              className="text-[var(--text-sm)]"
              style={{ color: "var(--color-text-muted)" }}
            >
              This one needs your hands — I can't patch it directly. Skip when
              you're ready to move on.
            </div>
            <div className="flex flex-wrap items-center gap-1.5">
              <button
                onClick={onAdvance}
                className="btn inline-flex items-center gap-1.5"
                style={{ padding: "5px 12px", fontSize: "var(--text-xs)" }}
              >
                {index + 1 >= total ? (
                  <>
                    Finish <Check size={11} />
                  </>
                ) : (
                  <>
                    Skip for now <ArrowRight size={11} />
                  </>
                )}
              </button>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </motion.div>
  );
}

type TimelineStep = "locating" | "diffing" | "compiling" | "reloading" | "done";

const TIMELINE_STEPS: Array<{ key: TimelineStep; label: string }> = [
  { key: "locating", label: "Locating the text in main.tex" },
  { key: "diffing", label: "Applying diff" },
  { key: "compiling", label: "Recompiling PDF" },
  { key: "reloading", label: "Reloading preview" },
];

function LiveEditTimeline({
  progress,
  detail,
  errored,
  onSkip,
  onRetry,
}: {
  progress: TimelineStep;
  detail?: string;
  errored: boolean;
  onSkip: () => void;
  onRetry: () => void;
}) {
  const order: TimelineStep[] = [
    "locating",
    "diffing",
    "compiling",
    "reloading",
    "done",
  ];
  const currentIndex = order.indexOf(progress);

  return (
    <div
      className="rounded-[var(--radius-md)] border px-[var(--space-3)] py-[var(--space-3)] space-y-2"
      style={{
        background: "var(--color-surface-2)",
        borderColor: errored
          ? "var(--color-skeptic)"
          : "var(--color-border)",
      }}
    >
      <div
        className="eyebrow"
        style={{
          color: errored
            ? "var(--color-skeptic)"
            : "var(--color-primary-strong)",
        }}
      >
        {errored ? "Apply failed" : "Applying change"}
      </div>
      <ul className="space-y-1.5">
        {TIMELINE_STEPS.map((step, i) => {
          const state: "done" | "active" | "pending" =
            errored && i > currentIndex
              ? "pending"
              : i < currentIndex
              ? "done"
              : i === currentIndex
              ? "active"
              : "pending";
          return (
            <li
              key={step.key}
              className="flex items-center gap-2 text-[var(--text-sm)]"
              style={{
                color:
                  state === "pending"
                    ? "var(--color-text-faint)"
                    : "var(--color-text)",
              }}
            >
              <TimelineDot state={state} errored={errored && state === "active"} />
              <span>{step.label}</span>
              {state === "active" && detail && (
                <span
                  className="ml-auto font-mono"
                  style={{
                    fontSize: "11px",
                    color: "var(--color-text-faint)",
                  }}
                >
                  {detail}
                </span>
              )}
              {state === "done" && (
                <Check
                  size={11}
                  className="ml-auto"
                  style={{ color: "var(--color-champion)" }}
                />
              )}
            </li>
          );
        })}
      </ul>
      {errored && (
        <div className="flex items-center gap-1.5 pt-1">
          <button
            onClick={onRetry}
            className="btn btn-primary inline-flex items-center gap-1"
            style={{ padding: "4px 10px", fontSize: "var(--text-xs)" }}
          >
            Retry
          </button>
          <button
            onClick={onSkip}
            className="btn-ghost inline-flex items-center gap-1 text-[var(--text-xs)]"
          >
            Skip
            <X size={11} />
          </button>
        </div>
      )}
    </div>
  );
}

function TimelineDot({
  state,
  errored,
}: {
  state: "done" | "active" | "pending";
  errored: boolean;
}) {
  if (state === "done") {
    return (
      <span
        className="inline-block rounded-full shrink-0"
        style={{
          width: 8,
          height: 8,
          background: "var(--color-champion)",
        }}
      />
    );
  }
  if (state === "active") {
    return (
      <motion.span
        className="inline-block rounded-full shrink-0"
        style={{
          width: 8,
          height: 8,
          background: errored
            ? "var(--color-skeptic)"
            : "var(--color-primary-strong)",
        }}
        animate={errored ? {} : { opacity: [0.4, 1, 0.4] }}
        transition={{ duration: 1.1, repeat: Infinity }}
      />
    );
  }
  return (
    <span
      className="inline-block rounded-full shrink-0"
      style={{
        width: 8,
        height: 8,
        border: "1px solid var(--color-border-strong)",
      }}
    />
  );
}
