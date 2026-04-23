"use client";

import { useState } from "react";
import { motion } from "framer-motion";
import {
  Check,
  ChevronRight,
  MapPin,
  MessageCircle,
  Wand2,
} from "lucide-react";
import type { ActionPlan as ActionPlanT, AuthorAction } from "@/lib/types";

const SEVERITY_META: Record<
  string,
  { label: string; color: string; defaultFix: "fix_now" | "suggest" }
> = {
  critical: { label: "Critical", color: "var(--color-skeptic)", defaultFix: "suggest" },
  major: { label: "Major", color: "var(--color-warning)", defaultFix: "suggest" },
  minor: { label: "Minor", color: "var(--color-text-muted)", defaultFix: "fix_now" },
};

export interface ActionPlanHandlers {
  /** Click the body of a row → zoom PDF + source. */
  onZoomTo?: (page?: number | null, line?: number | null) => void;
  /** Click the "Fix now" button → apply the fix_hint diff. */
  onFixNow?: (item: AuthorAction) => Promise<void> | void;
  /** Click the "Suggest a fix" button → pre-fill chat. */
  onSuggest?: (item: AuthorAction) => void;
}

function Item({
  item,
  handlers,
}: {
  item: AuthorAction;
  handlers: ActionPlanHandlers;
}) {
  const [open, setOpen] = useState(false);
  const [fixing, setFixing] = useState(false);
  const meta = SEVERITY_META[item.severity] || SEVERITY_META.minor;
  const canFixNow = Boolean(item.fix_hint && item.fix_hint.diff);
  const primaryAction = meta.defaultFix;

  const runFix = async () => {
    if (!handlers.onFixNow || !canFixNow) return;
    setFixing(true);
    try {
      await handlers.onFixNow(item);
    } finally {
      setFixing(false);
    }
  };

  return (
    <li
      className="border-b border-[color:var(--color-border)] last:border-b-0"
      style={item.applied ? { opacity: 0.55 } : undefined}
    >
      <div className="flex items-start gap-3 py-[var(--space-3)]">
        {/* Severity tick + clickable label area */}
        <button
          onClick={() => {
            setOpen((v) => !v);
            if (handlers.onZoomTo && (item.page_hint || item.tex_line_hint)) {
              handlers.onZoomTo(item.page_hint, item.tex_line_hint);
            }
          }}
          className="flex items-start gap-3 flex-1 text-left min-w-0"
        >
          <span
            className="mt-1.5 shrink-0 w-1 h-1 rounded-full"
            style={{ background: meta.color }}
          />
          <span className="flex-1 min-w-0">
            <span className="text-[var(--text-sm)] leading-snug block">
              {item.title}
            </span>
            {item.page_hint || item.estimated_effort ? (
              <span
                className="mt-1 inline-flex items-center gap-2 text-[11px] font-mono"
                style={{ color: "var(--color-text-faint)" }}
              >
                {item.page_hint && (
                  <span className="inline-flex items-center gap-0.5">
                    <MapPin size={10} />
                    p.{item.page_hint}
                  </span>
                )}
                {item.estimated_effort && <span>· {item.estimated_effort}</span>}
              </span>
            ) : null}
          </span>
        </button>

        {/* Primary action button */}
        <div className="flex items-center gap-1 shrink-0">
          {item.applied ? (
            <span
              className="chip inline-flex items-center gap-1"
              style={{ color: "var(--color-champion)", borderColor: "var(--color-champion)" }}
            >
              <Check size={11} />
              applied
            </span>
          ) : primaryAction === "fix_now" && canFixNow ? (
            <button
              onClick={runFix}
              disabled={fixing}
              className="btn btn-primary inline-flex items-center gap-1.5"
              style={{ padding: "4px 10px", fontSize: "var(--text-xs)" }}
            >
              <Wand2 size={11} />
              {fixing ? "fixing…" : "Fix now"}
            </button>
          ) : (
            <button
              onClick={() => handlers.onSuggest?.(item)}
              className="btn inline-flex items-center gap-1.5"
              style={{ padding: "4px 10px", fontSize: "var(--text-xs)" }}
            >
              <MessageCircle size={11} />
              Suggest
            </button>
          )}
          {/* Secondary ghost: the non-primary alternative when both are useful */}
          {!item.applied && primaryAction === "suggest" && canFixNow && (
            <button
              onClick={runFix}
              disabled={fixing}
              className="btn-ghost inline-flex items-center gap-1"
              title="Fix now — apply the suggested diff"
              style={{ padding: "4px 6px", fontSize: "var(--text-xs)" }}
            >
              <Wand2 size={11} />
            </button>
          )}
          <button
            onClick={() => setOpen((v) => !v)}
            className="icon-btn"
            aria-label={open ? "collapse" : "expand"}
            style={{ width: 24, height: 24 }}
          >
            <ChevronRight
              size={12}
              style={{
                transform: open ? "rotate(90deg)" : "none",
                transition: "transform 140ms ease",
              }}
            />
          </button>
        </div>
      </div>

      {open && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          className="pb-[var(--space-3)] text-[var(--text-sm)] leading-relaxed space-y-1.5"
          style={{ color: "var(--color-text-muted)", paddingLeft: "var(--space-4)" }}
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
          {item.fix_hint?.description && (
            <div
              className="mt-2 px-2 py-1.5 rounded-sm"
              style={{
                background: "var(--color-primary-highlight)",
                borderLeft: "2px solid var(--color-primary)",
                color: "var(--color-text)",
              }}
            >
              <span className="eyebrow mr-1.5" style={{ color: "var(--color-primary-strong)" }}>
                fix preview
              </span>
              {item.fix_hint.description}
            </div>
          )}
        </motion.div>
      )}
    </li>
  );
}

export function ActionPlan({
  plan,
  handlers,
}: {
  plan: ActionPlanT | null;
  handlers?: ActionPlanHandlers;
}) {
  if (!plan) return null;
  const h: ActionPlanHandlers = handlers || {};
  const buckets: Array<{ key: "critical" | "major" | "minor"; items: AuthorAction[] }> = [
    { key: "critical", items: [] },
    { key: "major", items: [] },
    { key: "minor", items: [] },
  ];
  for (const a of plan.author_required || []) {
    const b = buckets.find((x) => x.key === a.severity) || buckets[2];
    b.items.push(a);
  }
  const total = buckets.reduce((n, b) => n + b.items.length, 0);
  if (total === 0) return null;
  return (
    <div>
      <div className="eyebrow mb-[var(--space-2)]">
        Action plan · {total} item{total === 1 ? "" : "s"}
      </div>
      <div className="space-y-[var(--space-4)]">
        {buckets.map(
          (b) =>
            b.items.length > 0 && (
              <div key={b.key}>
                <div
                  className="eyebrow mb-1"
                  style={{ color: SEVERITY_META[b.key].color }}
                >
                  {SEVERITY_META[b.key].label} · {b.items.length}
                </div>
                <ul>
                  {b.items.map((a, i) => (
                    <Item key={a.id || i} item={a} handlers={h} />
                  ))}
                </ul>
              </div>
            )
        )}
      </div>
    </div>
  );
}
