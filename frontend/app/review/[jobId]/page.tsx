"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { useJob } from "@/lib/store";
import { Logo } from "@/components/Logo";
import { RoundIndicator } from "@/components/RoundIndicator";
import { CritiqueDelta } from "@/components/CritiqueDelta";
import { ReviewerStream } from "@/components/ReviewerStream";
import { LaTeXEditor } from "@/components/LaTeXEditor";
import { PDFPreview } from "@/components/PDFPreview";
import { VerdictCard } from "@/components/VerdictCard";
import { ActionPlan } from "@/components/ActionPlan";
import { PatchQueue } from "@/components/PatchQueue";
import { ThemeToggle, useIsDark } from "@/components/ThemeToggle";
import type { ReviewEvent } from "@/lib/types";

export default function WorkbenchPage() {
  const params = useParams<{ jobId: string }>();
  const jobId = params.jobId;
  const store = useJob();
  const isDark = useIsDark();
  const [patchMode, setPatchMode] = useState<"idle" | "one_by_one">("idle");
  const [focusedPatchId, setFocusedPatchId] = useState<string | null>(null);

  useEffect(() => {
    store.reset(jobId);
    const es = new EventSource(`/api/jobs/${jobId}/stream`);
    es.onmessage = (e) => {
      try {
        const ev = JSON.parse(e.data) as ReviewEvent;
        useJob.getState().ingest(ev);
      } catch {
        /* ignore */
      }
    };
    es.onerror = () => {
      // Browser will auto-reconnect per EventSource spec.
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

  return (
    <div className="h-screen flex flex-col">
      {/* Header */}
      <header className="flex items-center gap-4 px-4 h-12 border-b border-[color:var(--color-border)] bg-[color:var(--color-surface)]">
        <Link href="/" className="flex items-center gap-2 shrink-0">
          <Logo size={22} />
          <span className="font-mono text-sm tracking-tight">PeerMind</span>
        </Link>
        <div className="h-4 w-px bg-[color:var(--color-border)]" />
        <div className="truncate text-sm">
          {store.title || "Loading…"}
        </div>
        {store.journalFullName && (
          <span className="badge">{store.journalFullName}</span>
        )}
        <div className="flex-1" />
        <RoundIndicator
          current={store.currentRound || 1}
          max={store.maxRounds}
          complete={store.complete}
        />
        <CritiqueDelta delta={currentDelta} />
        <ThemeToggle />
      </header>

      {/* Body: three panes */}
      <div
        className="flex-1 min-h-0 grid"
        style={{ gridTemplateColumns: "280px 1fr 360px" }}
      >
        {/* Left: reviewer streams */}
        <aside className="min-h-0 border-r border-[color:var(--color-border)] bg-[color:var(--color-surface)] flex flex-col">
          <div className="px-3 py-2 text-xs font-mono uppercase tracking-wider text-[color:var(--color-text-dim)] border-b border-[color:var(--color-border)]">
            Reviewers
          </div>
          <div className="flex-1 min-h-0">
            <ReviewerStream />
          </div>
        </aside>

        {/* Center: editor */}
        <section className="min-h-0 flex flex-col bg-[color:var(--color-surface)]">
          <div className="flex-1 min-h-0">
            <LaTeXEditor
              jobId={jobId}
              filename={store.mainTex}
              available={Boolean(store.mainTex) && store.sourceType !== "pdf"}
              patches={store.patches}
              focusedPatchId={effectiveFocus}
              isDark={isDark}
            />
          </div>
          <PatchQueue
            jobId={jobId}
            patches={store.patches}
            mode={patchMode}
            setMode={setPatchMode}
            focusedPatchId={effectiveFocus}
            setFocused={setFocusedPatchId}
          />
        </section>

        {/* Right: PDF + verdict + action plan */}
        <aside className="min-h-0 border-l border-[color:var(--color-border)] bg-[color:var(--color-surface)] flex flex-col">
          <div className="flex-[1_1_55%] min-h-0 border-b border-[color:var(--color-border)]">
            <PDFPreview
              jobId={jobId}
              version={store.pdfVersion}
              compiling={store.pdfCompiling}
              error={store.lastCompileError}
            />
          </div>
          <div className="flex-[1_1_45%] min-h-0 overflow-y-auto scroll-pane p-3 space-y-3">
            <VerdictCard verdict={store.verdict} />
            <ActionPlan plan={store.actionPlan} />
            {store.errors.length > 0 && (
              <details className="card px-3 py-2 text-[11px] font-mono text-[color:var(--color-text-dim)]">
                <summary>{store.errors.length} warning{store.errors.length === 1 ? "" : "s"}</summary>
                <ul className="mt-1 space-y-1">
                  {store.errors.slice(-5).map((e, i) => (
                    <li key={i} className="text-[color:var(--color-danger)] break-all">
                      {e}
                    </li>
                  ))}
                </ul>
              </details>
            )}
          </div>
        </aside>
      </div>
    </div>
  );
}
