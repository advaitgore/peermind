"use client";

import { useEffect } from "react";
import type { AutoApplyPatch } from "@/lib/types";
import { applyPatch, applyAllPatches, rejectPatch } from "@/lib/api";
import { useJob } from "@/lib/store";

export function PatchQueue({
  jobId,
  patches,
  mode,
  setMode,
  focusedPatchId,
  setFocused,
}: {
  jobId: string;
  patches: AutoApplyPatch[];
  mode: "idle" | "one_by_one";
  setMode: (m: "idle" | "one_by_one") => void;
  focusedPatchId: string | null;
  setFocused: (id: string | null) => void;
}) {
  const pending = patches.filter((p) => p.status === "pending");
  const applied = patches.filter((p) => p.status === "applied").length;
  const rejected = patches.filter((p) => p.status === "rejected").length;

  const optimistApply = useJob((s) => s.optimisticallyApply);
  const optimistReject = useJob((s) => s.optimisticallyReject);

  const focused = focusedPatchId ? patches.find((p) => p.patch_id === focusedPatchId) : null;

  const handleApply = async (id: string) => {
    optimistApply(id);
    await applyPatch(jobId, id);
    const next = pending.find((p) => p.patch_id !== id);
    if (next) setFocused(next.patch_id);
    else setMode("idle");
  };
  const handleReject = async (id: string) => {
    optimistReject(id);
    await rejectPatch(jobId, id);
    const next = pending.find((p) => p.patch_id !== id);
    if (next) setFocused(next.patch_id);
    else setMode("idle");
  };

  useEffect(() => {
    if (mode !== "one_by_one") return;
    const handler = (e: KeyboardEvent) => {
      if (!focused) return;
      if (e.key === "a" || e.key === "A") handleApply(focused.patch_id);
      else if (e.key === "r" || e.key === "R") handleReject(focused.patch_id);
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, focused?.patch_id]);

  if (patches.length === 0) return null;

  return (
    <div className="border-t border-[color:var(--color-border)] bg-[color:var(--color-surface-2)]">
      <div className="flex items-center gap-3 px-3 py-2 text-[12px]">
        <span className="badge">
          {pending.length} pending · {applied} applied · {rejected} rejected
        </span>
        <div className="flex-1" />
        {mode === "idle" ? (
          <>
            <button
              className="btn"
              disabled={pending.length === 0}
              onClick={() => {
                setMode("one_by_one");
                if (pending[0]) setFocused(pending[0].patch_id);
              }}
            >
              Review one by one
            </button>
            <button
              className="btn btn-primary"
              disabled={pending.length === 0}
              onClick={async () => {
                pending.forEach((p) => optimistApply(p.patch_id));
                await applyAllPatches(jobId);
              }}
            >
              Auto-apply all
            </button>
          </>
        ) : (
          focused && (
            <>
              <span className="font-mono text-[11px] text-[color:var(--color-text-dim)]">
                {focused.category}
              </span>
              <span className="text-[12px] truncate max-w-[40ch]">{focused.description}</span>
              <button
                className="btn"
                onClick={() => handleReject(focused.patch_id)}
                title="Reject (R)"
              >
                Reject <kbd className="ml-1 text-[10px]">R</kbd>
              </button>
              <button
                className="btn btn-primary"
                onClick={() => handleApply(focused.patch_id)}
                title="Apply (A)"
              >
                Apply <kbd className="ml-1 text-[10px]">A</kbd>
              </button>
            </>
          )
        )}
      </div>
    </div>
  );
}
