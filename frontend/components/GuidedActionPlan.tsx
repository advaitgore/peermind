"use client";

import { useEffect, useState } from "react";
import { motion } from "framer-motion";
import { ArrowRight, Check, MapPin, Wand2 } from "lucide-react";
import type { AuthorAction } from "@/lib/types";
import type { ActionPlanHandlers } from "./ActionPlan";

const SEVERITY_COLOR: Record<string, string> = {
  critical: "var(--color-skeptic)",
  major: "var(--color-warning)",
  minor: "var(--color-text-muted)",
};

export function GuidedActionPlan({
  item,
  index,
  total,
  applied,
  handlers,
  onAdvance,
  onShowList,
}: {
  item: AuthorAction;
  index: number;
  total: number;
  applied: boolean;
  handlers: ActionPlanHandlers;
  onAdvance: () => void;
  onShowList: () => void;
}) {
  const [fixing, setFixing] = useState(false);
  const canFixNow = Boolean(item.fix_hint?.diff);
  const severityColor = SEVERITY_COLOR[item.severity] || SEVERITY_COLOR.minor;

  // Auto-zoom the PDF to this item's location when it becomes the active
  // issue — the user shouldn't need to click to see where on the paper
  // we're talking about.
  useEffect(() => {
    handlers.onZoomTo?.(item.page_hint ?? null, item.tex_line_hint ?? null);
  }, [item.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const runFix = async () => {
    if (!handlers.onFixNow || !canFixNow) return;
    setFixing(true);
    try {
      await handlers.onFixNow(item);
      // Auto-advance after the patch lands so the user stays in flow.
      setTimeout(() => onAdvance(), 900);
    } finally {
      setFixing(false);
    }
  };

  return (
    <motion.div
      key={item.id}
      initial={{ opacity: 0, y: 4 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.25 }}
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
        {item.title}
      </div>

      <div
        className="space-y-1.5 text-[var(--text-sm)] leading-relaxed"
        style={{ color: "var(--color-text-muted)" }}
      >
        {item.affected_claim && (
          <div>
            <span className="eyebrow mr-1.5">claim</span>
            {item.affected_claim}
          </div>
        )}
        {item.evidence && (
          <div>
            <span className="eyebrow mr-1.5">evidence</span>
            {item.evidence}
          </div>
        )}
        {item.suggested_action && (
          <div style={{ color: "var(--color-text)" }}>
            <span className="eyebrow mr-1.5">do</span>
            {item.suggested_action}
          </div>
        )}
      </div>

      {canFixNow && item.fix_hint?.description && (
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
          {item.fix_hint.description}
        </div>
      )}

      {applied ? (
        <div className="flex items-center gap-2 pt-1">
          <span
            className="chip inline-flex items-center gap-1"
            style={{ color: "var(--color-champion)", borderColor: "var(--color-champion)" }}
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
                Finish
                <Check size={11} />
              </>
            ) : (
              <>
                Next issue
                <ArrowRight size={11} />
              </>
            )}
          </button>
        </div>
      ) : canFixNow ? (
        <div className="space-y-2 pt-1">
          <div
            className="text-[var(--text-sm)]"
            style={{ color: "var(--color-text)" }}
          >
            Would you like me to make this change?
          </div>
          <div className="flex flex-wrap items-center gap-1.5">
            <button
              onClick={runFix}
              disabled={fixing}
              className="btn btn-primary inline-flex items-center gap-1.5"
              style={{ padding: "5px 12px", fontSize: "var(--text-xs)" }}
            >
              <Wand2 size={11} />
              {fixing ? "Applying…" : "Yes, apply it"}
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
        </div>
      ) : (
        <div className="space-y-2 pt-1">
          <div
            className="text-[var(--text-sm)]"
            style={{ color: "var(--color-text-muted)" }}
          >
            I can't patch this one directly — it needs author work. Skip when
            you're ready.
          </div>
          <div className="flex flex-wrap items-center gap-1.5">
            <button
              onClick={onAdvance}
              className="btn inline-flex items-center gap-1.5"
              style={{ padding: "5px 12px", fontSize: "var(--text-xs)" }}
            >
              {index + 1 >= total ? (
                <>
                  Finish
                  <Check size={11} />
                </>
              ) : (
                <>
                  Skip for now
                  <ArrowRight size={11} />
                </>
              )}
            </button>
          </div>
        </div>
      )}
    </motion.div>
  );
}
