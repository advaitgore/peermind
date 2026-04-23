import { useCallback, useRef, useState } from "react";
import { applyPatch } from "./api";
import type { AutoApplyPatch } from "./types";

export interface AutoApplyState {
  active: boolean;
  currentIndex: number; // 1-based for display
  total: number;
  description: string;
}

// Parse the @@ header from a unified diff to find the first affected line.
// Returns 1-based line number, or undefined if malformed.
function firstAffectedLine(diff: string): number | undefined {
  const m = diff.match(/@@\s*-(\d+)/);
  if (!m) return undefined;
  return parseInt(m[1], 10);
}

export interface AutoApplyApi {
  state: AutoApplyState;
  run: (patches: AutoApplyPatch[]) => Promise<void>;
  cancel: () => void;
}

export function useAutoApply({
  jobId,
  onFocusLine,
  onBeforeApply,
  onAfterCompile,
  delayBetweenMs = 1800,
}: {
  jobId: string;
  onFocusLine?: (line: number) => void;
  onBeforeApply?: (patch: AutoApplyPatch, index: number, total: number) => void;
  onAfterCompile?: (patch: AutoApplyPatch, index: number, total: number) => void;
  delayBetweenMs?: number;
}): AutoApplyApi {
  const [state, setState] = useState<AutoApplyState>({
    active: false,
    currentIndex: 0,
    total: 0,
    description: "",
  });
  const cancelRef = useRef(false);

  const run = useCallback(
    async (patches: AutoApplyPatch[]) => {
      const pending = patches.filter((p) => p.status === "pending");
      if (pending.length === 0) return;
      cancelRef.current = false;
      setState({
        active: true,
        currentIndex: 0,
        total: pending.length,
        description: "",
      });
      for (let i = 0; i < pending.length; i++) {
        if (cancelRef.current) break;
        const patch = pending[i];
        setState({
          active: true,
          currentIndex: i + 1,
          total: pending.length,
          description: patch.description || patch.category,
        });
        const line = firstAffectedLine(patch.diff);
        if (line && onFocusLine) onFocusLine(line);
        onBeforeApply?.(patch, i + 1, pending.length);
        // Give the Monaco scroll + highlight animations 400ms to land before
        // we actually mutate the source.
        await wait(400);
        try {
          await applyPatch(jobId, patch.patch_id);
        } catch (e) {
          console.error("applyPatch failed", patch.patch_id, e);
        }
        onAfterCompile?.(patch, i + 1, pending.length);
        if (i < pending.length - 1) {
          await wait(delayBetweenMs);
        } else {
          await wait(700);
        }
      }
      setState((s) => ({ ...s, active: false }));
    },
    [jobId, onFocusLine, onBeforeApply, onAfterCompile, delayBetweenMs]
  );

  const cancel = useCallback(() => {
    cancelRef.current = true;
    setState((s) => ({ ...s, active: false }));
  }, []);

  return { state, run, cancel };
}

function wait(ms: number) {
  return new Promise<void>((r) => setTimeout(r, ms));
}
