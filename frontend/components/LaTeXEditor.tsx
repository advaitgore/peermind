"use client";

import dynamic from "next/dynamic";
import { useEffect, useRef, useState } from "react";
import type { AutoApplyPatch } from "@/lib/types";
import { fetchSourceText } from "@/lib/api";

const Monaco = dynamic(() => import("@monaco-editor/react").then((m) => m.default), {
  ssr: false,
  loading: () => (
    <div className="h-full flex items-center justify-center text-xs font-mono text-[color:var(--color-text-faint)]">
      loading editor…
    </div>
  ),
});
const DiffEditor = dynamic(() => import("@monaco-editor/react").then((m) => m.DiffEditor), {
  ssr: false,
  loading: () => null,
});

function applyDiffClientSide(original: string, diff: string): string {
  // Best-effort client-side preview of a unified diff. Server authoritatively
  // applies via unidiff — this is only for visual comparison in the DiffEditor.
  if (!diff) return original;
  const lines = original.split(/\r?\n/);
  const hunks = diff.split(/^@@.*@@/m).slice(1);
  const headers = [...diff.matchAll(/@@ -(\d+)(?:,\d+)? \+\d+(?:,\d+)? @@/gm)];
  if (!hunks.length || hunks.length !== headers.length) return original;
  let out = [...lines];
  // Apply hunks from bottom up so line offsets stay valid.
  for (let i = hunks.length - 1; i >= 0; i--) {
    const body = hunks[i];
    const start = parseInt(headers[i][1], 10) - 1;
    const src: string[] = [];
    const tgt: string[] = [];
    for (const raw of body.split("\n")) {
      if (raw.startsWith("-")) src.push(raw.slice(1));
      else if (raw.startsWith("+")) tgt.push(raw.slice(1));
      else if (raw.startsWith(" ")) {
        src.push(raw.slice(1));
        tgt.push(raw.slice(1));
      }
    }
    out = [...out.slice(0, start), ...tgt, ...out.slice(start + src.length)];
  }
  return out.join("\n");
}

export function LaTeXEditor({
  jobId,
  filename,
  available,
  patches,
  focusedPatchId,
  focusLine,
  isDark,
  onLineClick,
  totalLinesReport,
}: {
  jobId: string;
  filename: string | null;
  available: boolean;
  patches: AutoApplyPatch[];
  focusedPatchId: string | null;
  focusLine?: number | null;
  isDark: boolean;
  onLineClick?: (line: number, totalLines: number) => void;
  totalLinesReport?: (n: number) => void;
}) {
  const [source, setSource] = useState<string>("");
  const [loading, setLoading] = useState(true);
  const [view, setView] = useState<"source" | "diff">("source");
  const editorRef = useRef<any>(null);
  const decorationsRef = useRef<any>(null);

  useEffect(() => {
    let cancelled = false;
    if (!available) {
      setLoading(false);
      setSource("");
      return;
    }
    setLoading(true);
    fetchSourceText(jobId).then((r) => {
      if (cancelled) return;
      setSource(r.content);
      setLoading(false);
    });
    return () => {
      cancelled = true;
    };
  }, [jobId, available]);

  // When the cinematic auto-apply focuses a line, center it in the Monaco
  // viewport and flash a subtle highlight decoration for ~1.5s.
  useEffect(() => {
    const refObj = editorRef.current;
    if (!refObj || !focusLine || view !== "source") return;
    const { editor, monaco } = refObj;
    try {
      editor.revealLineInCenter(focusLine, 1); // 1 = Smooth
      const range = new monaco.Range(focusLine, 1, focusLine, 1);
      const newDecos = editor.deltaDecorations(decorationsRef.current || [], [
        {
          range,
          options: {
            isWholeLine: true,
            className: "monaco-peermind-focus-line",
            linesDecorationsClassName: "monaco-peermind-focus-gutter",
          },
        },
      ]);
      decorationsRef.current = newDecos;
      const t = setTimeout(() => {
        try {
          editor.deltaDecorations(decorationsRef.current || [], []);
          decorationsRef.current = null;
        } catch {}
      }, 1500);
      return () => clearTimeout(t);
    } catch (e) {
      console.debug("focusLine failed", e);
    }
  }, [focusLine, view]);

  const focused = patches.find((p) => p.patch_id === focusedPatchId) || null;
  const canDiff = Boolean(focused);

  if (!available) {
    return (
      <div className="h-full flex items-center justify-center text-center px-8 text-sm text-[color:var(--color-text-dim)]">
        <div>
          <div className="font-mono text-xs uppercase tracking-wider mb-2">PDF upload</div>
          Source editing not available — upload a .tex or .zip for live patch/recompile.
        </div>
      </div>
    );
  }

  return (
    <div className="h-full flex flex-col">
      <div className="flex items-center justify-between px-3 py-2 text-xs font-mono uppercase tracking-wider text-[color:var(--color-text-dim)] border-b border-[color:var(--color-border)]">
        <div className="flex items-center gap-1">
          <button
            className={`px-2 py-0.5 rounded ${
              view === "source" ? "bg-[color:var(--color-surface-2)] text-[color:var(--color-text)]" : ""
            }`}
            onClick={() => setView("source")}
          >
            Source
          </button>
          <button
            className={`px-2 py-0.5 rounded ${
              view === "diff" ? "bg-[color:var(--color-surface-2)] text-[color:var(--color-text)]" : ""
            } ${!canDiff ? "opacity-40 cursor-not-allowed" : ""}`}
            onClick={() => canDiff && setView("diff")}
            disabled={!canDiff}
          >
            Diff
          </button>
        </div>
        <div className="text-[color:var(--color-text-faint)]">{filename}</div>
      </div>
      <div className="flex-1 min-h-0">
        {loading ? (
          <div className="h-full flex items-center justify-center text-xs font-mono text-[color:var(--color-text-faint)]">
            loading source…
          </div>
        ) : view === "diff" && focused ? (
          <DiffEditor
            original={source}
            modified={applyDiffClientSide(source, focused.diff)}
            language="latex"
            theme={isDark ? "vs-dark" : "vs"}
            options={{
              renderSideBySide: true,
              readOnly: true,
              minimap: { enabled: false },
              fontSize: 13,
              fontFamily: "JetBrains Mono, Fira Code, monospace",
              automaticLayout: true,
              smoothScrolling: true,
            }}
          />
        ) : (
          <Monaco
            value={source}
            language="latex"
            theme={isDark ? "vs-dark" : "vs"}
            onMount={(editor, monaco) => {
              editorRef.current = { editor, monaco };
              const model = editor.getModel();
              if (model && totalLinesReport) {
                totalLinesReport(model.getLineCount());
              }
              // Click → jump PDF. Fires on any mouse click inside the editor;
              // we grab the clicked line and let the workbench sync the PDF.
              editor.onMouseDown((e: any) => {
                const line = e?.target?.position?.lineNumber;
                const total = model?.getLineCount() ?? 0;
                if (typeof line === "number" && line > 0 && onLineClick) {
                  onLineClick(line, total);
                }
              });
            }}
            options={{
              readOnly: true,
              minimap: { enabled: false },
              wordWrap: "on",
              fontSize: 13,
              fontFamily: "JetBrains Mono, Fira Code, monospace",
              scrollBeyondLastLine: false,
              // Narrow right-rail width can change on source/verdict toggle;
              // automaticLayout makes Monaco resize itself + keeps scroll
              // responsive inside the tight container.
              automaticLayout: true,
              smoothScrolling: true,
              mouseWheelScrollSensitivity: 1.2,
            }}
          />
        )}
      </div>
    </div>
  );
}
