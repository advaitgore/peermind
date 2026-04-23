"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { motion, AnimatePresence } from "framer-motion";
import { AlertTriangle, ChevronRight, Settings2 } from "lucide-react";
import { useJob } from "@/lib/store";
import { applyAdhocPatch, streamUrl } from "@/lib/api";
import { Logo } from "@/components/Logo";
import { LaTeXEditor } from "@/components/LaTeXEditor";
import { PDFPreview, type PDFPreviewHandle } from "@/components/PDFPreview";
import { VerdictCard } from "@/components/VerdictCard";
import { ActionPlan, type ActionPlanHandlers } from "@/components/ActionPlan";
import { PatchQueue } from "@/components/PatchQueue";
import { AgentStatusPanel } from "@/components/AgentStatusPanel";
import { ReviewerStream } from "@/components/ReviewerStream";
import { AutoApplyToast } from "@/components/AutoApplyToast";
import { ChatBar, type ChatBarHandle } from "@/components/ChatBar";
import { useIsDark } from "@/components/ThemeToggle";
import { useAutoApply } from "@/lib/useAutoApply";
import type { ReviewEvent } from "@/lib/types";

export default function WorkbenchPage() {
  const params = useParams<{ jobId: string }>();
  const jobId = params.jobId;
  const store = useJob();
  const isDark = useIsDark();
  const [patchMode, setPatchMode] = useState<"idle" | "one_by_one">("idle");
  const [focusedPatchId, setFocusedPatchId] = useState<string | null>(null);
  const [focusLine, setFocusLine] = useState<number | null>(null);
  const [sourceOpen, setSourceOpen] = useState(false);
  const pdfRef = useRef<PDFPreviewHandle | null>(null);
  const chatRef = useRef<ChatBarHandle | null>(null);
  const [appliedActionIds, setAppliedActionIds] = useState<Set<string>>(new Set());

  const onZoomTo = (page?: number | null, line?: number | null) => {
    if (page && pdfRef.current) {
      pdfRef.current.scrollToPage(page, { flash: true });
    }
    if (line) {
      setSourceOpen(true);
      setFocusLine(line);
    }
  };

  const actionPlanHandlers: ActionPlanHandlers = {
    onZoomTo,
    onSuggest: (item) => {
      const prompt = `How should I address — "${item.title}"${
        item.affected_claim ? `: ${item.affected_claim}` : ""
      }? Draft a concrete revision plan.`;
      chatRef.current?.prefill(prompt);
    },
    onFixNow: async (item) => {
      if (!item.fix_hint) return;
      try {
        setSourceOpen(true);
        if (item.tex_line_hint) setFocusLine(item.tex_line_hint);
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

  const autoApply = useAutoApply({
    jobId,
    onFocusLine: (line) => {
      setSourceOpen(true);
      setFocusLine(line);
    },
  });

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

  const latestPatch = store.patches.find((p) => p.status === "pending");
  const effectiveFocus =
    patchMode === "one_by_one" ? focusedPatchId : latestPatch?.patch_id ?? null;

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

        {/* Center — PDF hero */}
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
          {store.patches.length > 0 && (
            <PatchQueue
              jobId={jobId}
              patches={store.patches}
              mode={patchMode}
              setMode={setPatchMode}
              focusedPatchId={effectiveFocus}
              setFocused={setFocusedPatchId}
              onAutoApplyAll={() => {
                setSourceOpen(true);
                autoApply.run(store.patches);
              }}
              autoApplyActive={autoApply.state.active}
            />
          )}
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
              verdict={store.verdict}
              actionPlan={store.actionPlan}
              critiqueDelta={currentDelta}
              errors={store.errors}
              hasSource={hasSource}
              onOpenSource={() => setSourceOpen(true)}
              actionPlanHandlers={actionPlanHandlers}
              appliedActionIds={appliedActionIds}
            />
          )}
        </aside>
      </div>

      {/* Bottom bar */}
      <ChatBar ref={chatRef} jobId={jobId} />

      <AutoApplyToast
        visible={autoApply.state.active}
        index={autoApply.state.currentIndex}
        total={autoApply.state.total}
        description={autoApply.state.description}
      />
    </div>
  );
}

function VerdictRail({
  jobId,
  verdict,
  actionPlan,
  critiqueDelta,
  errors,
  hasSource,
  onOpenSource,
  actionPlanHandlers,
  appliedActionIds,
}: {
  jobId: string;
  verdict: any;
  actionPlan: any;
  critiqueDelta: number | undefined;
  errors: string[];
  hasSource: boolean;
  onOpenSource: () => void;
  actionPlanHandlers: ActionPlanHandlers;
  appliedActionIds: Set<string>;
}) {
  // Decorate each author_required item with local `applied: true` so the
  // ActionPlan can grey it out + show the "applied" chip.
  const decoratedPlan = actionPlan
    ? {
        ...actionPlan,
        author_required: (actionPlan.author_required || []).map((a: any) => ({
          ...a,
          applied: appliedActionIds.has(a.id) || a.applied,
        })),
      }
    : null;
  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center px-[var(--space-4)] h-10 border-b border-[color:var(--color-border)]">
        <h2
          className="font-display font-semibold"
          style={{ fontSize: "var(--text-lg)", letterSpacing: "-0.01em" }}
        >
          Verdict & action plan
        </h2>
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto scroll-pane space-y-[var(--space-5)]">
        <div className="px-[var(--space-4)] pt-[var(--space-4)]">
          <VerdictCard verdict={verdict} jobId={jobId} critiqueDelta={critiqueDelta} />
        </div>

        {!verdict && (
          <>
            <div className="tick-divider mx-[var(--space-4)]" />
            <div>
              <div className="px-[var(--space-4)] eyebrow mb-[var(--space-2)]">
                Live reviewer critique
              </div>
              <div className="min-h-[400px]">
                <ReviewerStream />
              </div>
            </div>
          </>
        )}

        {verdict && (
          <>
            <div className="tick-divider mx-[var(--space-4)]" />
            <div className="px-[var(--space-4)]">
              <ActionPlan plan={decoratedPlan} handlers={actionPlanHandlers} />
            </div>
          </>
        )}

        {errors.length > 0 && (
          <div className="px-[var(--space-4)]">
            <WarningDetails errors={errors} />
          </div>
        )}
        <div className="h-[var(--space-4)]" />
      </div>

      {hasSource && (
        <div className="border-t border-[color:var(--color-border)] px-[var(--space-4)] py-[var(--space-3)]">
          <button
            onClick={onOpenSource}
            className="btn-ghost inline-flex items-center gap-1.5 text-[var(--text-sm)] w-full justify-center"
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

function WarningDetails({ errors }: { errors: string[] }) {
  return (
    <details
      className="rounded-[var(--radius-md)] border"
      style={{
        background: "var(--color-warning-bg)",
        borderColor: "rgba(217,168,74,0.3)",
      }}
    >
      <summary
        className="flex items-center gap-2 px-[var(--space-3)] py-[var(--space-2)] cursor-pointer text-[var(--text-sm)]"
        style={{ color: "var(--color-warning)" }}
      >
        <AlertTriangle size={14} />
        <span>
          {errors.length} warning{errors.length === 1 ? "" : "s"}
        </span>
        <span className="eyebrow ml-auto" style={{ color: "var(--color-warning)" }}>
          click to expand
        </span>
      </summary>
      <div className="px-[var(--space-3)] pb-[var(--space-3)] space-y-1">
        {errors.slice(-5).map((e, i) => (
          <pre
            key={i}
            className="text-[11px] font-mono whitespace-pre-wrap break-all"
            style={{ color: "var(--color-warning)" }}
          >
            {e}
          </pre>
        ))}
      </div>
    </details>
  );
}
