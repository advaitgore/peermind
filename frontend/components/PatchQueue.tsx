"use client";

import { useEffect } from "react";
import { Check, X, Wand2 } from "lucide-react";
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
  onAutoApplyAll,
  autoApplyActive,
}: {
  jobId: string;
  patches: AutoApplyPatch[];
  mode: "idle" | "one_by_one";
  setMode: (m: "idle" | "one_by_one") => void;
  focusedPatchId: string | null;
  setFocused: (id: string | null) => void;
  onAutoApplyAll?: () => void;
  autoApplyActive?: boolean;
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
    <div className="border-t border-[color:var(--color-border)] bg-[color:var(--color-surface)]">
      <div className="flex items-center gap-3 px-[var(--space-4)] py-[var(--space-3)] text-[var(--text-sm)]">
        <span className="eyebrow">
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
              className="btn btn-primary inline-flex items-center gap-2"
              disabled={pending.length === 0 || autoApplyActive}
              onClick={() => {
                if (onAutoApplyAll) onAutoApplyAll();
                else {
                  pending.forEach((p) => optimistApply(p.patch_id));
                  void applyAllPatches(jobId);
                }
              }}
            >
              <Wand2 size={14} />
              {autoApplyActive ? "Applying…" : "Auto-apply all"}
            </button>
          </>
        ) : (
          focused && (
            <>
              <span className="chip">{focused.category}</span>
              <span
                className="text-[var(--text-sm)] truncate"
                style={{ maxWidth: "40ch", color: "var(--color-text-muted)" }}
              >
                {focused.description}
              </span>
              <button
                className="btn inline-flex items-center gap-1.5"
                onClick={() => handleReject(focused.patch_id)}
                title="Reject (R)"
              >
                <X size={13} />
                Reject <kbd className="ml-1 text-[10px] opacity-70">R</kbd>
              </button>
              <button
                className="btn btn-primary inline-flex items-center gap-1.5"
                onClick={() => handleApply(focused.patch_id)}
                title="Apply (A)"
              >
                <Check size={13} />
                Apply <kbd className="ml-1 text-[10px] opacity-70">A</kbd>
              </button>
            </>
          )
        )}
      </div>
    </div>
  );
}
