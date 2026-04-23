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

export type AgentStatus = "idle" | "running" | "done" | "error";

export type AgentId =
  | "orchestrator"
  | "reviewer1"
  | "reviewer2"
  | "scout"
  | "code_runner"
  | "fix_agent";

export interface AgentState {
  id: AgentId;
  label: string;
  status: AgentStatus;
  // monotonic counter so dots can animate on update
  lastTickAt: number;
}

const INITIAL_AGENTS: Record<AgentId, AgentState> = {
  orchestrator: { id: "orchestrator", label: "Orchestrator", status: "idle", lastTickAt: 0 },
  reviewer1: { id: "reviewer1", label: "Reviewer 1", status: "idle", lastTickAt: 0 },
  reviewer2: { id: "reviewer2", label: "Reviewer 2", status: "idle", lastTickAt: 0 },
  scout: { id: "scout", label: "Literature Scout", status: "idle", lastTickAt: 0 },
  code_runner: { id: "code_runner", label: "Code Runner", status: "idle", lastTickAt: 0 },
  fix_agent: { id: "fix_agent", label: "Fix Agent", status: "idle", lastTickAt: 0 },
};

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

  /** Sub-step progress for the currently-applying patch. Drives the
   *  AutoApplyToast's 4-dot timeline. null while nothing is applying. */
  applyProgress: {
    patchId: string;
    step: "locating" | "diffing" | "compiling" | "reloading" | "done";
    detail?: string;
  } | null;

  agents: Record<AgentId, AgentState>;

  /**
   * Max event seq seen so far. The backend event bus replays full history
   * on every new SSE subscriber, so when the browser auto-reconnects (which
   * it does on stream close), we'd re-ingest every event and re-run every
   * side effect (pdfVersion++, text appends, etc.). We dedupe by seq:
   * events at or below lastSeq are silently dropped.
   */
  lastSeq: number;

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
  applyProgress: null,
  agents: { ...INITIAL_AGENTS },
  lastSeq: 0,
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
      // Dedupe replayed events. On EventSource reconnect the backend replays
      // the full per-job history; without this guard pdfVersion and reviewer
      // token text would keep growing each reconnect.
      if (ev.seq && ev.seq <= s.lastSeq) {
        return s;
      }
      const state: JobState = {
        ...s,
        rounds: { ...s.rounds },
        agents: { ...s.agents },
        lastSeq: ev.seq || s.lastSeq,
      };
      const setAgent = (id: AgentId, status: AgentStatus) => {
        state.agents[id] = {
          ...state.agents[id],
          status,
          lastTickAt: Date.now(),
        };
      };
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
          setAgent("orchestrator", "running");
          return state;
        }
        case "round_started": {
          const r = ev.round || 1;
          state.currentRound = r;
          state.maxRounds = (ev.data as { of?: number }).of ?? s.maxRounds;
          ensureRound(state, r);
          setAgent("reviewer1", "running");
          setAgent("reviewer2", "running");
          return state;
        }
        case "reviewer_token": {
          const r = ev.round || state.currentRound || 1;
          const rnd = { ...ensureRound(state, r) };
          const text = (ev.data as { text?: string }).text ?? "";
          if (ev.agent === "skeptic") {
            rnd.skepticText = (rnd.skepticText || "") + text;
            setAgent("reviewer1", "running");
          }
          if (ev.agent === "champion") {
            rnd.championText = (rnd.championText || "") + text;
            setAgent("reviewer2", "running");
          }
          state.rounds[r] = rnd;
          return state;
        }
        case "reviewer_complete": {
          const r = ev.round || state.currentRound || 1;
          const rnd = { ...ensureRound(state, r) };
          const review = (ev.data as { review?: ReviewerOutput }).review;
          if (review) {
            if (ev.agent === "skeptic") {
              rnd.skepticReview = review;
              setAgent("reviewer1", "done");
            }
            if (ev.agent === "champion") {
              rnd.championReview = review;
              setAgent("reviewer2", "done");
            }
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
        case "literature_started": {
          setAgent("scout", "running");
          return state;
        }
        case "literature_found": {
          const r = ev.round || state.currentRound;
          const findings = (ev.data as { findings?: LiteratureFinding[] }).findings ?? [];
          const rnd = { ...ensureRound(state, r) };
          rnd.literature = findings;
          state.rounds[r] = rnd;
          state.literatureAll = [...s.literatureAll, ...findings];
          setAgent("scout", "done");
          return state;
        }
        case "code_started": {
          setAgent("code_runner", "running");
          return state;
        }
        case "code_run_result": {
          const r = ev.round || state.currentRound;
          const results = (ev.data as { results?: CodeRunResult[] }).results ?? [];
          const rnd = { ...ensureRound(state, r) };
          rnd.code = results;
          state.rounds[r] = rnd;
          state.codeAll = [...s.codeAll, ...results];
          setAgent("code_runner", "done");
          return state;
        }
        case "round_complete": {
          const r = ev.round || state.currentRound;
          const rnd = { ...ensureRound(state, r) };
          rnd.converged = !!(ev.data as { converged?: boolean }).converged;
          state.rounds[r] = rnd;
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
          setAgent("orchestrator", "done");
          setAgent("fix_agent", "running");
          return state;
        }
        case "patch_ready": {
          setAgent("fix_agent", "running");
          // fall through intentionally — the existing patch_ready logic is in its own case below
          // we re-dispatch by returning here and let the downstream reducer re-run the event
          // but actually we can't do that with switch, so keep both behaviors here:
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
        case "action_plan_ready": {
          state.actionPlan = (ev.data as { action_plan: ActionPlan }).action_plan;
          setAgent("fix_agent", "done");
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
          // Close the apply sub-timeline shortly after reloading.
          if (state.applyProgress) {
            state.applyProgress = { ...state.applyProgress, step: "done" };
          }
          return state;
        }
        case "compile_error": {
          state.pdfCompiling = false;
          state.lastCompileError = (ev.data as { log?: string }).log ?? "compile failed";
          state.applyProgress = null;
          return state;
        }
        case "patch_locating": {
          const d = ev.data as { patch_id: string; line?: number; file?: string };
          state.applyProgress = {
            patchId: d.patch_id,
            step: "locating",
            detail:
              d.line != null && d.file
                ? `${d.file}:${d.line}`
                : d.file ?? undefined,
          };
          return state;
        }
        case "patch_diffing": {
          const d = ev.data as { patch_id: string; lines_changed?: number };
          state.applyProgress = {
            patchId: d.patch_id,
            step: "diffing",
            detail: d.lines_changed != null ? `${d.lines_changed} lines` : undefined,
          };
          return state;
        }
        case "patch_compiling": {
          const d = ev.data as { patch_id: string };
          state.applyProgress = {
            patchId: d.patch_id,
            step: "compiling",
            detail: "latexmk…",
          };
          return state;
        }
        case "patch_reloading": {
          const d = ev.data as { patch_id: string; elapsed_ms?: number };
          state.applyProgress = {
            patchId: d.patch_id,
            step: "reloading",
            detail: d.elapsed_ms != null ? `${(d.elapsed_ms / 1000).toFixed(1)}s` : undefined,
          };
          return state;
        }
        case "job_complete": {
          state.complete = true;
          // Any still-idle agents were never used in this job; leave as idle.
          // Any still-running agents should flip to done to avoid stale
          // "streaming" dots post-complete.
          for (const k of Object.keys(state.agents) as AgentId[]) {
            if (state.agents[k].status === "running") {
              state.agents[k] = { ...state.agents[k], status: "done" };
            }
          }
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
