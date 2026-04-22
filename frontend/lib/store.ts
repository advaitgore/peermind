import { create } from "zustand";
import type {
  ActionPlan,
  AutoApplyPatch,
  CodeRunResult,
  LiteratureFinding,
  ReviewEvent,
  ReviewerOutput,
  Verdict,
} from "./types";

interface StreamText {
  skeptic: string;
  champion: string;
}

interface PerRoundState {
  skepticText: StreamText["skeptic"];
  championText: StreamText["champion"];
  skepticReview?: ReviewerOutput;
  championReview?: ReviewerOutput;
  deltaFromPrev?: number;
  literature?: LiteratureFinding[];
  code?: CodeRunResult[];
  converged?: boolean;
}

export interface JobState {
  jobId: string | null;
  journal: string | null;
  journalFullName: string | null;
  title: string | null;
  mainTex: string | null;
  sourceType: string | null;

  currentRound: number;
  maxRounds: number;
  rounds: Record<number, PerRoundState>;

  literatureAll: LiteratureFinding[];
  codeAll: CodeRunResult[];

  patches: AutoApplyPatch[];
  actionPlan: ActionPlan | null;
  verdict: Verdict | null;

  pdfVersion: number; // monotonically increasing, used to force <iframe>/react-pdf reload
  pdfCompiling: boolean;
  lastCompileError: string | null;

  complete: boolean;
  errors: string[];
}

interface Actions {
  reset: (jobId: string) => void;
  ingest: (ev: ReviewEvent) => void;
  setMeta: (meta: Partial<Pick<JobState, "title" | "journal" | "journalFullName" | "mainTex" | "sourceType">>) => void;
  optimisticallyApply: (patchId: string) => void;
  optimisticallyReject: (patchId: string) => void;
}

const INITIAL: Omit<JobState, "jobId"> = {
  journal: null,
  journalFullName: null,
  title: null,
  mainTex: null,
  sourceType: null,
  currentRound: 0,
  maxRounds: 3,
  rounds: {},
  literatureAll: [],
  codeAll: [],
  patches: [],
  actionPlan: null,
  verdict: null,
  pdfVersion: 0,
  pdfCompiling: false,
  lastCompileError: null,
  complete: false,
  errors: [],
};

function ensureRound(state: JobState, n: number): PerRoundState {
  if (!state.rounds[n]) {
    state.rounds[n] = { skepticText: "", championText: "" };
  }
  return state.rounds[n];
}

export const useJob = create<JobState & Actions>((set, get) => ({
  jobId: null,
  ...INITIAL,

  reset(jobId) {
    set({ jobId, ...INITIAL });
  },

  setMeta(meta) {
    set((s) => ({ ...s, ...meta }));
  },

  optimisticallyApply(patchId) {
    set((s) => ({
      patches: s.patches.map((p) =>
        p.patch_id === patchId ? { ...p, status: "applied" } : p
      ),
      pdfCompiling: true,
    }));
  },

  optimisticallyReject(patchId) {
    set((s) => ({
      patches: s.patches.map((p) =>
        p.patch_id === patchId ? { ...p, status: "rejected" } : p
      ),
    }));
  },

  ingest(ev) {
    set((s) => {
      const state: JobState = { ...s, rounds: { ...s.rounds } };
      switch (ev.event_type) {
        case "job_started": {
          const d = ev.data as {
            journal?: string;
            journal_full_name?: string;
            title?: string;
            main_tex?: string | null;
            source_type?: string;
          };
          if (d.journal) state.journal = d.journal;
          if (d.journal_full_name) state.journalFullName = d.journal_full_name;
          if (d.title) state.title = d.title;
          if (d.main_tex) state.mainTex = d.main_tex;
          if (d.source_type) state.sourceType = d.source_type;
          return state;
        }
        case "round_started": {
          const r = ev.round || 1;
          state.currentRound = r;
          state.maxRounds = (ev.data as { of?: number }).of ?? s.maxRounds;
          ensureRound(state, r);
          return state;
        }
        case "reviewer_token": {
          const r = ev.round || state.currentRound || 1;
          const rnd = { ...ensureRound(state, r) };
          const text = (ev.data as { text?: string }).text ?? "";
          if (ev.agent === "skeptic") rnd.skepticText = (rnd.skepticText || "") + text;
          if (ev.agent === "champion") rnd.championText = (rnd.championText || "") + text;
          state.rounds[r] = rnd;
          return state;
        }
        case "reviewer_complete": {
          const r = ev.round || state.currentRound || 1;
          const rnd = { ...ensureRound(state, r) };
          const review = (ev.data as { review?: ReviewerOutput }).review;
          if (review) {
            if (ev.agent === "skeptic") rnd.skepticReview = review;
            if (ev.agent === "champion") rnd.championReview = review;
          }
          state.rounds[r] = rnd;
          return state;
        }
        case "critique_delta": {
          const r = ev.round || state.currentRound;
          const rnd = { ...ensureRound(state, r) };
          rnd.deltaFromPrev = (ev.data as { delta?: number }).delta ?? 1;
          state.rounds[r] = rnd;
          return state;
        }
        case "literature_found": {
          const r = ev.round || state.currentRound;
          const findings = (ev.data as { findings?: LiteratureFinding[] }).findings ?? [];
          const rnd = { ...ensureRound(state, r) };
          rnd.literature = findings;
          state.rounds[r] = rnd;
          state.literatureAll = [...s.literatureAll, ...findings];
          return state;
        }
        case "code_run_result": {
          const r = ev.round || state.currentRound;
          const results = (ev.data as { results?: CodeRunResult[] }).results ?? [];
          const rnd = { ...ensureRound(state, r) };
          rnd.code = results;
          state.rounds[r] = rnd;
          state.codeAll = [...s.codeAll, ...results];
          return state;
        }
        case "round_complete": {
          const r = ev.round || state.currentRound;
          const rnd = { ...ensureRound(state, r) };
          rnd.converged = !!(ev.data as { converged?: boolean }).converged;
          state.rounds[r] = rnd;
          return state;
        }
        case "patch_ready": {
          const d = ev.data as {
            patch_id: string;
            description: string;
            category: AutoApplyPatch["category"];
            diff: string;
          };
          state.patches = [
            ...s.patches,
            {
              patch_id: d.patch_id,
              description: d.description,
              category: d.category,
              diff: d.diff,
              status: "pending",
            },
          ];
          return state;
        }
        case "patch_applied": {
          const id = (ev.data as { patch_id: string }).patch_id;
          state.patches = s.patches.map((p) =>
            p.patch_id === id ? { ...p, status: "applied" } : p
          );
          return state;
        }
        case "patch_rejected": {
          const id = (ev.data as { patch_id: string }).patch_id;
          state.patches = s.patches.map((p) =>
            p.patch_id === id ? { ...p, status: "rejected" } : p
          );
          return state;
        }
        case "verdict_ready": {
          state.verdict = (ev.data as { verdict: Verdict }).verdict;
          return state;
        }
        case "action_plan_ready": {
          state.actionPlan = (ev.data as { action_plan: ActionPlan }).action_plan;
          return state;
        }
        case "compile_started": {
          state.pdfCompiling = true;
          state.lastCompileError = null;
          return state;
        }
        case "compile_success": {
          state.pdfCompiling = false;
          state.pdfVersion = s.pdfVersion + 1;
          state.lastCompileError = null;
          return state;
        }
        case "compile_error": {
          state.pdfCompiling = false;
          state.lastCompileError = (ev.data as { log?: string }).log ?? "compile failed";
          return state;
        }
        case "job_complete": {
          state.complete = true;
          return state;
        }
        case "error": {
          const detail = (ev.data as { detail?: string }).detail ?? "error";
          state.errors = [...s.errors, detail];
          return state;
        }
        default:
          return state;
      }
    });
  },
}));

export function useSubscribeStream(jobId: string) {
  if (typeof window === "undefined") return;
  const ingest = useJob.getState().ingest;
  const es = new EventSource(`/api/jobs/${jobId}/stream`);
  es.onmessage = (e) => {
    try {
      const ev = JSON.parse(e.data) as ReviewEvent;
      ingest(ev);
    } catch {
      /* ignore */
    }
  };
  return () => es.close();
}
