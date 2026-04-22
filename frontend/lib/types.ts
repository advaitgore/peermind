// Mirror of backend/models/schemas.py — keep in sync.

export type EventType =
  | "job_started"
  | "round_started"
  | "reviewer_token"
  | "reviewer_complete"
  | "literature_started"
  | "literature_found"
  | "code_started"
  | "code_run_result"
  | "round_complete"
  | "critique_delta"
  | "verdict_ready"
  | "action_plan_ready"
  | "patch_ready"
  | "patch_applied"
  | "patch_rejected"
  | "compile_started"
  | "compile_success"
  | "compile_error"
  | "job_complete"
  | "error";

export type AgentId =
  | "orchestrator"
  | "skeptic"
  | "champion"
  | "scout"
  | "code_runner"
  | "fix_agent"
  | "system";

export type JournalId = "neurips" | "icml" | "iclr" | "nature" | "science" | "arxiv";

export interface ReviewEvent<T = Record<string, unknown>> {
  seq: number;
  event_type: EventType;
  agent: AgentId;
  round: number;
  data: T;
  timestamp: string;
}

export interface JournalProfile {
  id?: JournalId;
  full_name: string;
  criteria: string[];
  score_range: [number, number];
  strong_accept_threshold: number | null;
  reviewer_guidelines_summary: string;
  persona_skeptic_inject: string;
  persona_champion_inject: string;
}

export interface Weakness {
  issue: string;
  severity: "critical" | "major" | "minor";
  evidence?: string;
  suggested_fix?: string;
}

export interface ReviewerOutput {
  summary: string;
  strengths: string[];
  weaknesses: Weakness[];
  key_claims_to_verify: string[];
  scores: Record<string, number>;
  confidence: number;
  recommendation: string;
  updated_from_previous: string[];
}

export interface LiteratureFinding {
  claim: string;
  category: "contradicts" | "missing_prior_art" | "methodological_precedent";
  papers: Array<{
    title?: string;
    authors?: string[];
    year?: number;
    id?: string;
    relevance?: string;
    citationCount?: number;
  }>;
}

export interface CodeRunResult {
  block_id: number;
  language: string;
  status: "passed" | "failed" | "timeout" | "dependency_missing" | "skipped";
  exit_code?: number | null;
  stdout_tail?: string;
  stderr_tail?: string;
  reproducibility_concern?: string | null;
}

export interface AutoApplyPatch {
  patch_id: string;
  description: string;
  diff: string;
  category: "citation" | "typo" | "notation" | "caption" | "phrasing";
  status?: "pending" | "applied" | "rejected" | "requires_manual_review";
}

export interface AuthorAction {
  id: string;
  title: string;
  severity: "critical" | "major" | "minor";
  affected_claim?: string;
  evidence?: string;
  suggested_action?: string;
  estimated_effort?: "hours" | "days" | "weeks";
}

export interface Verdict {
  recommendation: string;
  confidence: number;
  one_line_verdict?: string;
  reviewer_recommendations?: Record<string, string>;
  consensus_issues?: Array<{
    issue: string;
    severity: "critical" | "major" | "minor";
    rounds_raised?: number[];
  }>;
  disagreements_arbitrated?: Array<{
    topic: string;
    skeptic_view?: string;
    champion_view?: string;
    resolution?: string;
    evidence?: string;
  }>;
  scores_synthesis?: Record<string, number>;
}

export interface ActionPlan {
  auto_apply_patches: AutoApplyPatch[];
  author_required: AuthorAction[];
}
