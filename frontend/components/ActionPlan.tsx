"use client";

import { useState } from "react";
import type { ActionPlan as ActionPlanT, AuthorAction } from "@/lib/types";

const SEVERITY_META: Record<string, { label: string; dot: string }> = {
  critical: { label: "Critical", dot: "bg-[color:var(--color-skeptic)]" },
  major: { label: "Major", dot: "bg-[color:var(--color-warn)]" },
  minor: { label: "Minor", dot: "bg-[color:var(--color-text-faint)]" },
};

function Item({ item }: { item: AuthorAction }) {
  const [open, setOpen] = useState(false);
  const meta = SEVERITY_META[item.severity] || SEVERITY_META.minor;
  return (
    <li className="border-b border-[color:var(--color-border)] last:border-b-0">
      <button
        onClick={() => setOpen((v) => !v)}
        className="w-full flex items-start gap-2 px-3 py-2 text-left hover:bg-[color:var(--color-surface-2)]"
      >
        <span className={`mt-1.5 inline-block w-2 h-2 rounded-full ${meta.dot}`} />
        <span className="flex-1 text-[13px]">{item.title}</span>
        {item.estimated_effort && (
          <span className="badge text-[10px]">{item.estimated_effort}</span>
        )}
      </button>
      {open && (
        <div className="px-3 pb-3 text-[12px] space-y-1.5">
          {item.affected_claim && (
            <div>
              <span className="font-mono text-[11px] uppercase text-[color:var(--color-text-dim)] mr-1">
                claim:
              </span>
              {item.affected_claim}
            </div>
          )}
          {item.evidence && (
            <div>
              <span className="font-mono text-[11px] uppercase text-[color:var(--color-text-dim)] mr-1">
                evidence:
              </span>
              {item.evidence}
            </div>
          )}
          {item.suggested_action && (
            <div>
              <span className="font-mono text-[11px] uppercase text-[color:var(--color-text-dim)] mr-1">
                do:
              </span>
              {item.suggested_action}
            </div>
          )}
        </div>
      )}
    </li>
  );
}

export function ActionPlan({ plan }: { plan: ActionPlanT | null }) {
  if (!plan) return null;
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
    <div className="card">
      <div className="px-3 py-2 border-b border-[color:var(--color-border)] text-[11px] font-mono uppercase tracking-wider text-[color:var(--color-text-dim)]">
        Action plan · {total} item{total === 1 ? "" : "s"}
      </div>
      {buckets.map(
        (b) =>
          b.items.length > 0 && (
            <div key={b.key}>
              <div className="px-3 py-1.5 text-[11px] font-mono uppercase tracking-wider text-[color:var(--color-text-dim)] bg-[color:var(--color-surface-2)]">
                {SEVERITY_META[b.key].label} ({b.items.length})
              </div>
              <ul>
                {b.items.map((a, i) => (
                  <Item key={a.id || i} item={a} />
                ))}
              </ul>
            </div>
          )
      )}
    </div>
  );
}
