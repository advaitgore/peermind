"use client";

import { useState } from "react";
import { motion } from "framer-motion";
import { useJob } from "@/lib/store";
import { ReviewerStream } from "./ReviewerStream";
import { AgentStatusPanel } from "./AgentStatusPanel";
import type { CodeRunResult, LiteratureFinding } from "@/lib/types";

type Tab = "reviews" | "literature" | "code";

function LiteraturePanel() {
  const items = useJob((s) => s.literatureAll);
  if (items.length === 0) {
    return (
      <EmptyState
        title="no findings yet"
        hint="The Literature Scout runs between rounds. Findings appear here as they arrive."
      />
    );
  }
  return (
    <div className="h-full overflow-y-auto scroll-pane px-3 py-3 space-y-3">
      {items.map((f: LiteratureFinding, i) => (
        <motion.div
          key={`${f.claim}-${i}`}
          initial={{ opacity: 0, y: 4 }}
          animate={{ opacity: 1, y: 0 }}
          className="card-tight px-3 py-2 text-[12px]"
        >
          <div className="font-mono text-[10px] uppercase tracking-wider text-[color:var(--color-text-dim)] mb-1">
            {f.category.replace(/_/g, " ")}
          </div>
          <div className="text-[12px] mb-2 leading-snug">{f.claim}</div>
          <ul className="space-y-1.5">
            {(f.papers || []).slice(0, 4).map((p, k) => (
              <li key={k} className="text-[11.5px] leading-snug">
                <div className="font-medium">{p.title || "(untitled)"}</div>
                <div className="text-[color:var(--color-text-dim)]">
                  {(p.authors || []).slice(0, 3).join(", ")}
                  {p.year ? ` · ${p.year}` : ""}
                  {typeof p.citationCount === "number"
                    ? ` · ${p.citationCount} cites`
                    : ""}
                </div>
                {p.relevance && (
                  <div className="text-[11px] mt-0.5 text-[color:var(--color-text-dim)]">
                    {p.relevance}
                  </div>
                )}
              </li>
            ))}
          </ul>
        </motion.div>
      ))}
    </div>
  );
}

function CodePanel() {
  const items = useJob((s) => s.codeAll);
  if (items.length === 0) {
    return (
      <EmptyState
        title="no code runs yet"
        hint="The Code Runner executes each code block from the paper. Results appear here."
      />
    );
  }
  return (
    <div className="h-full overflow-y-auto scroll-pane px-3 py-3 space-y-2">
      {items.map((r: CodeRunResult, i) => {
        const color =
          r.status === "passed"
            ? "text-[color:var(--color-champion)]"
            : r.status === "failed" || r.status === "timeout"
            ? "text-[color:var(--color-skeptic)]"
            : "text-[color:var(--color-warn)]";
        return (
          <motion.div
            key={i}
            initial={{ opacity: 0, y: 4 }}
            animate={{ opacity: 1, y: 0 }}
            className="card-tight px-3 py-2 text-[11.5px]"
          >
            <div className="flex items-center justify-between font-mono text-[10.5px] uppercase tracking-wider text-[color:var(--color-text-dim)]">
              <span>block {r.block_id} · {r.language || "?"}</span>
              <span className={color}>{r.status}</span>
            </div>
            {r.reproducibility_concern && (
              <div className="mt-1 text-[12px] text-[color:var(--color-skeptic)]">
                {r.reproducibility_concern}
              </div>
            )}
            {r.stderr_tail && (
              <pre className="mt-1.5 font-mono text-[10.5px] max-h-24 overflow-auto scroll-pane text-[color:var(--color-text-dim)] whitespace-pre-wrap">
                {r.stderr_tail.slice(-500)}
              </pre>
            )}
          </motion.div>
        );
      })}
    </div>
  );
}

function EmptyState({ title, hint }: { title: string; hint: string }) {
  return (
    <div className="h-full flex items-center justify-center text-center text-[12px] text-[color:var(--color-text-faint)] font-mono px-6">
      <div>
        <div className="mb-2">{title}</div>
        <div className="text-[10.5px] leading-relaxed">{hint}</div>
      </div>
    </div>
  );
}

export function WorkbenchSidebar({ jobId }: { jobId: string }) {
  const [tab, setTab] = useState<Tab>("reviews");
  const litCount = useJob((s) => s.literatureAll.length);
  const codeCount = useJob((s) => s.codeAll.length);

  const tabs: Array<{ id: Tab; label: string; badge?: number }> = [
    { id: "reviews", label: "Reviews" },
    { id: "literature", label: "Literature", badge: litCount || undefined },
    { id: "code", label: "Code", badge: codeCount || undefined },
  ];

  return (
    <div className="h-full flex flex-col bg-[color:var(--color-surface)]">
      <AgentStatusPanel />
      <div className="flex items-center border-b border-[color:var(--color-border)] px-1">
        {tabs.map((t) => (
          <button
            key={t.id}
            aria-selected={tab === t.id}
            onClick={() => setTab(t.id)}
            className="tab-btn"
          >
            <span>{t.label}</span>
            {t.badge ? (
              <span className="text-[9px] px-1 py-0.5 rounded bg-[color:var(--color-surface-3)] text-[color:var(--color-text-dim)]">
                {t.badge}
              </span>
            ) : null}
          </button>
        ))}
      </div>
      <div className="flex-1 min-h-0">
        {tab === "reviews" && <ReviewerStream />}
        {tab === "literature" && <LiteraturePanel />}
        {tab === "code" && <CodePanel />}
      </div>
    </div>
  );
}
