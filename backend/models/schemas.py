"""Pydantic schemas for SSE events and API request/response bodies.

Every event streamed from the backend to the frontend is serialized as
`ReviewEvent.model_dump_json()` and emitted as an SSE `data:` line. The
frontend parses it with the TypeScript `ReviewEvent` type in `frontend/lib/types.ts`.
"""
from __future__ import annotations

from datetime import datetime, timezone
from typing import Any, Literal, Optional

from pydantic import BaseModel, Field

EventType = Literal[
    "job_started",
    "round_started",
    "reviewer_token",
    "reviewer_complete",
    "literature_started",
    "literature_found",
    "code_started",
    "code_run_result",
    "round_complete",
    "critique_delta",
    "verdict_ready",
    "action_plan_ready",
    "patch_ready",
    "patch_applied",
    "patch_rejected",
    # Fine-grained apply sub-steps — drives the AutoApplyToast sub-timeline
    # (locating → diffing → compiling → reloading) so the user can see what
    # the Fix Agent is doing instead of staring at a single spinner.
    "patch_locating",
    "patch_diffing",
    "patch_compiling",
    "patch_reloading",
    # Synthesis extended-thinking trace — streamed token-by-token from
    # Opus 4.7's thinking blocks so the user watches Claude reason.
    "synthesis_thinking",
    "synthesis_thinking_done",
    # Rebuttal stream — the Rebuttal Co-Pilot streams its response live.
    "rebuttal_started",
    "rebuttal_token",
    "rebuttal_complete",
    "compile_started",
    "compile_success",
    "compile_error",
    "job_complete",
    "error",
]

AgentId = Literal["orchestrator", "skeptic", "champion", "scout", "code_runner", "fix_agent", "system"]

JournalId = Literal["neurips", "icml", "iclr", "nature", "science", "arxiv", "custom"]


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


class ReviewEvent(BaseModel):
    """One streaming event. Ordered by `seq` within a job."""

    seq: int = 0
    event_type: EventType
    agent: AgentId = "system"
    round: int = 0
    data: dict[str, Any] = Field(default_factory=dict)
    timestamp: str = Field(default_factory=_now_iso)


# --- API request/response shapes ---


class JournalProfile(BaseModel):
    id: JournalId
    full_name: str
    criteria: list[str]
    score_range: list[int]
    strong_accept_threshold: int | None = None
    reviewer_guidelines_summary: str
    persona_skeptic_inject: str
    persona_champion_inject: str


class DetectedVenue(BaseModel):
    journal_id: JournalId
    display_name: str
    rationale: str = ""
    confidence: float = 0.5


class JobCreateResponse(BaseModel):
    job_id: str
    title: str
    source_type: Literal["tex", "zip", "pdf", "arxiv"]
    has_source: bool
    detected_venue: DetectedVenue | None = None


class StartJobRequest(BaseModel):
    journal: JournalId
    # When journal == "custom", the display name the user typed. Gets
    # substituted into the custom profile's {journal_name} placeholders so
    # reviewers speak about the correct venue.
    custom_venue_name: str | None = None


class StartJobResponse(BaseModel):
    job_id: str
    status: Literal["started"]


class Weakness(BaseModel):
    issue: str
    severity: Literal["critical", "major", "minor"]
    evidence: Optional[str] = None
    suggested_fix: Optional[str] = None


class ReviewerOutput(BaseModel):
    summary: str
    strengths: list[str] = Field(default_factory=list)
    weaknesses: list[Weakness] = Field(default_factory=list)
    key_claims_to_verify: list[str] = Field(default_factory=list)
    scores: dict[str, float] = Field(default_factory=dict)
    confidence: float = 0.5
    recommendation: str
    updated_from_previous: list[str] = Field(default_factory=list)


class LiteratureFinding(BaseModel):
    claim: str
    category: Literal["contradicts", "missing_prior_art", "methodological_precedent"]
    papers: list[dict[str, Any]] = Field(default_factory=list)


class CodeRunResult(BaseModel):
    block_id: int
    language: str
    status: Literal["passed", "failed", "timeout", "dependency_missing", "skipped"]
    exit_code: Optional[int] = None
    stdout_tail: str = ""
    stderr_tail: str = ""
    reproducibility_concern: Optional[str] = None


class AutoApplyPatch(BaseModel):
    patch_id: str
    description: str
    diff: str
    category: Literal["citation", "typo", "notation", "caption", "phrasing"]
    status: Literal["pending", "applied", "rejected", "requires_manual_review"] = "pending"


class FixHint(BaseModel):
    """Optional inline patch attached to an AuthorAction. If present, the
    frontend can offer a 'Fix now' button that applies this diff scoped to
    just this item (bypassing the regular auto-apply queue)."""
    category: Literal["citation", "typo", "notation", "caption", "phrasing"] = "phrasing"
    diff: str
    description: str = ""


class AuthorAction(BaseModel):
    id: str
    title: str
    severity: Literal["critical", "major", "minor"]
    affected_claim: str = ""
    evidence: str = ""
    suggested_action: str = ""
    estimated_effort: Literal["hours", "days", "weeks"] = "days"
    # Location hints — Fix Agent estimates roughly where in the paper/source
    # this item lives. Click-to-zoom uses these.
    page_hint: int | None = None
    tex_line_hint: int | None = None
    # If Fix Agent can produce a concrete edit, offer it.
    fix_hint: FixHint | None = None


class Verdict(BaseModel):
    recommendation: str
    confidence: float
    one_line_verdict: str = ""
    reviewer_recommendations: dict[str, str] = Field(default_factory=dict)
    consensus_issues: list[dict[str, Any]] = Field(default_factory=list)
    disagreements_arbitrated: list[dict[str, Any]] = Field(default_factory=list)
    scores_synthesis: dict[str, float] = Field(default_factory=dict)
    # Probability (0-1) that the paper would be accepted at the target venue
    # given the evidence — produced by Opus 4.7 with extended thinking.
    acceptance_probability: float | None = None


class ActionPlan(BaseModel):
    auto_apply_patches: list[AutoApplyPatch] = Field(default_factory=list)
    author_required: list[AuthorAction] = Field(default_factory=list)
