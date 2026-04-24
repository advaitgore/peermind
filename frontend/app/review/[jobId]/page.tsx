"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { ChevronRight, Settings2 } from "lucide-react";
import { useJob } from "@/lib/store";
import { applyAdhocPatch, streamUrl } from "@/lib/api";
import { Logo } from "@/components/Logo";
import { LaTeXEditor } from "@/components/LaTeXEditor";
import { PDFPreview, type PDFPreviewHandle } from "@/components/PDFPreview";
import {
  ConversationRail,
  type ConversationRailHandle,
} from "@/components/ConversationRail";
import { RailFooter } from "@/components/RailFooter";
import { type ActionPlanHandlers } from "@/components/ActionPlan";
import { AgentStatusPanel } from "@/components/AgentStatusPanel";
import { useIsDark } from "@/components/ThemeToggle";
import type { ReviewEvent } from "@/lib/types";

export default function WorkbenchPage() {
  const params = useParams<{ jobId: string }>();
  const jobId = params.jobId;
  const store = useJob();
  const isDark = useIsDark();
  const [focusLine, setFocusLine] = useState<number | null>(null);
  const [sourceOpen, setSourceOpen] = useState(false);
  const pdfRef = useRef<PDFPreviewHandle | null>(null);
  const railRef = useRef<ConversationRailHandle | null>(null);
  const [appliedActionIds, setAppliedActionIds] = useState<Set<string>>(new Set());

  // Click-to-zoom: only scroll the PDF + flash the target page. We
  // intentionally do NOT pop the source view anymore — the user stays
  // focused on the paper, not the LaTeX. `focusLine` is still set so the
  // source panel (if the user opens it) lands in the right place.
  const onZoomTo = (page?: number | null, line?: number | null) => {
    if (page && pdfRef.current) {
      pdfRef.current.scrollToPage(page, { flash: true });
    }
    if (line) setFocusLine(line);
  };

  const actionPlanHandlers: ActionPlanHandlers = {
    onZoomTo,
    onFixNow: async (item) => {
      if (!item.fix_hint) return;
      try {
        if (item.tex_line_hint) setFocusLine(item.tex_line_hint);
        if (item.page_hint && pdfRef.current) {
          pdfRef.current.scrollToPage(item.page_hint, { flash: true });
        }
        await applyAdhocPatch(jobId, {
          diff: item.fix_hint.diff,
          description: item.fix_hint.description || item.title,
          category: item.fix_hint.category || "phrasing",
          source_action_id: item.id,
        });
        setAppliedActionIds((prev) => new Set(prev).add(item.id));
      } catch (e) {
        console.error("onFixNow failed", e);
      }
    },
  };

  useEffect(() => {
    store.reset(jobId);
    const es = new EventSource(streamUrl(jobId));
    es.onmessage = (e) => {
      try {
        const ev = JSON.parse(e.data) as ReviewEvent;
        useJob.getState().ingest(ev);
      } catch (err) {
        console.error("[peermind] parse failed", err, e.data);
      }
    };
    return () => es.close();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jobId]);

  const currentDelta =
    store.currentRound && store.rounds[store.currentRound]
      ? store.rounds[store.currentRound].deltaFromPrev
      : undefined;

  // Source editor focus pointer — still used by LaTeXEditor when the user
  // explicitly opens the source rail. Falls back to the latest pending
  // patch so the editor highlights it in context.
  const effectiveFocus =
    store.patches.find((p) => p.status === "pending")?.patch_id ?? null;

  const hasSource = Boolean(store.mainTex) && store.sourceType !== "pdf";

  return (
    <div className="h-dvh flex flex-col" style={{ background: "var(--color-bg)" }}>
      {/* Minimal toolbar */}
      <header className="flex items-center gap-4 px-[var(--space-5)] h-14 border-b border-[color:var(--color-border)]">
        <Link href="/" className="flex items-center gap-2.5 shrink-0">
          <Logo size={22} />
          <span className="font-display text-[var(--text-md)] tracking-tight">PeerMind</span>
        </Link>
        <div className="flex-1 min-w-0 flex items-center justify-center gap-3">
          <span
            className="text-[var(--text-sm)] font-display truncate"
            style={{ color: "var(--color-text)", maxWidth: "60ch" }}
          >
            {store.title || "Loading paper…"}
          </span>
          {store.journalFullName && (
            <span className="chip shrink-0">{store.journalFullName}</span>
          )}
        </div>
        <button className="icon-btn shrink-0" aria-label="settings">
          <Settings2 size={16} />
        </button>
      </header>

      {/* Three-column grid */}
      <div
        className="flex-1 min-h-0 grid"
        style={{ gridTemplateColumns: "240px minmax(0, 1fr) 380px" }}
      >
        {/* Left — agent sidebar */}
        <aside className="min-h-0 overflow-y-auto scroll-pane border-r border-[color:var(--color-border)]">
          <AgentStatusPanel />
        </aside>

        {/* Center — PDF hero (takes the whole column now) */}
        <section className="min-h-0 flex flex-col">
          <div className="flex-1 min-h-0">
            <PDFPreview
              ref={pdfRef}
              jobId={jobId}
              version={store.pdfVersion}
              compiling={store.pdfCompiling}
              error={store.lastCompileError}
              title={store.title}
            />
          </div>
        </section>

        {/* Right — verdict & action plan (or source when toggled) */}
        <aside className="min-h-0 overflow-y-auto scroll-pane border-l border-[color:var(--color-border)] flex flex-col">
          {sourceOpen && hasSource ? (
            <SourceRail
              jobId={jobId}
              filename={store.mainTex}
              hasSource={hasSource}
              patches={store.patches}
              focusedPatchId={effectiveFocus}
              focusLine={focusLine}
              isDark={isDark}
              onClose={() => setSourceOpen(false)}
              onLineClick={(line, total) => {
                if (!pdfRef.current || total <= 0) return;
                pdfRef.current.scrollToRatio(line / total);
              }}
            />
          ) : (
            <VerdictRail
              jobId={jobId}
              critiqueDelta={currentDelta}
              hasSource={hasSource}
              onOpenSource={() => setSourceOpen(true)}
              actionPlanHandlers={actionPlanHandlers}
              appliedActionIds={appliedActionIds}
              railRef={railRef}
            />
          )}
        </aside>
      </div>

    </div>
  );
}

function VerdictRail({
  jobId,
  critiqueDelta,
  hasSource,
  onOpenSource,
  actionPlanHandlers,
  appliedActionIds,
  railRef,
}: {
  jobId: string;
  critiqueDelta: number | undefined;
  hasSource: boolean;
  onOpenSource: () => void;
  actionPlanHandlers: ActionPlanHandlers;
  appliedActionIds: Set<string>;
  railRef: React.RefObject<ConversationRailHandle | null>;
}) {
  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center px-[var(--space-4)] h-10 border-b border-[color:var(--color-border)]">
        <h2
          className="font-display font-semibold"
          style={{ fontSize: "var(--text-lg)", letterSpacing: "-0.01em" }}
        >
          Conversation
        </h2>
      </div>

      <ConversationRail
        ref={railRef}
        jobId={jobId}
        critiqueDelta={critiqueDelta}
        handlers={actionPlanHandlers}
        appliedActionIds={appliedActionIds}
      />

      <RailFooter jobId={jobId} />

      {hasSource && (
        <div className="border-t border-[color:var(--color-border)] px-[var(--space-4)] py-[var(--space-2)]">
          <button
            onClick={onOpenSource}
            className="btn-ghost inline-flex items-center gap-1.5 text-[var(--text-xs)] w-full justify-center"
          >
            <span>Show source</span>
            <ChevronRight size={14} />
          </button>
        </div>
      )}
    </div>
  );
}

function SourceRail({
  jobId,
  filename,
  hasSource,
  patches,
  focusedPatchId,
  focusLine,
  isDark,
  onClose,
  onLineClick,
}: {
  jobId: string;
  filename: string | null;
  hasSource: boolean;
  patches: any[];
  focusedPatchId: string | null;
  focusLine: number | null;
  isDark: boolean;
  onClose: () => void;
  onLineClick: (line: number, total: number) => void;
}) {
  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center justify-between px-[var(--space-4)] h-10 border-b border-[color:var(--color-border)]">
        <span className="eyebrow">Source · {filename}</span>
        <button
          onClick={onClose}
          className="btn-ghost inline-flex items-center gap-1 text-[var(--text-xs)]"
        >
          show verdict
        </button>
      </div>
      <div className="flex-1 min-h-0">
        <LaTeXEditor
          jobId={jobId}
          filename={filename}
          available={hasSource}
          patches={patches}
          focusedPatchId={focusedPatchId}
          focusLine={focusLine}
          isDark={isDark}
          onLineClick={onLineClick}
        />
      </div>
    </div>
  );
}

