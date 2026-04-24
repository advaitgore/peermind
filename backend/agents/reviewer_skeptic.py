"""Skeptic reviewer — adversarial critique scoped to a target venue."""
from __future__ import annotations

import json
from typing import Any

from .agent_factory import AgentSpec
from .skills import load_skill, render_prompt


def build_skeptic_spec(journal: dict[str, Any]) -> AgentSpec:
    skill = load_skill("skeptic")
    ctx = {
        "journal_name": journal["full_name"],
        "journal_rubric": journal["reviewer_guidelines_summary"],
        "journal_skeptic_inject": journal["persona_skeptic_inject"],
        "journal_criteria": journal["criteria"],
        "journal_score_range": journal["score_range"],
        "round_num": "{round_num}",  # kept as a placeholder, we render per round
    }
    system = render_prompt(skill.system_prompt_template, ctx)
    return AgentSpec(
        name=f"peermind-skeptic-{journal.get('id', 'unknown')}",
        # Sonnet 4.5 on reviewers — ~2-3× faster than Opus for this scale of
        # task and critiques are not materially worse. Synthesis (Opus 4.7
        # with extended thinking) is where we earn back quality.
        model="claude-sonnet-4-5",
        system=system,
        tools=[{"type": "agent_toolset_20260401"}],
        # Keep the budget tight — reviewer JSON + prose fit in 3k comfortably.
        max_tokens=3072,
    )


def build_skeptic_user_message(
    round_num: int,
    paper_text: str,
    previous_reviews: list[dict[str, Any]],
    literature_findings: list[dict[str, Any]],
    code_results: list[dict[str, Any]],
) -> str:
    parts = [
        f"=== REVIEW ROUND {round_num} ===",
        "",
        "## Paper (LaTeX source or extracted text)",
        paper_text[:120_000],
    ]
    if previous_reviews:
        parts.extend(
            [
                "",
                "## Your previous rounds (yours = 'a', champion = 'b')",
                json.dumps(previous_reviews, indent=2)[:30_000],
            ]
        )
    if literature_findings:
        parts.extend(
            [
                "",
                "## Literature findings from the Scout",
                json.dumps(literature_findings, indent=2)[:15_000],
            ]
        )
    if code_results:
        parts.extend(
            [
                "",
                "## Code-execution results from the Code Runner",
                json.dumps(code_results, indent=2)[:10_000],
            ]
        )
    parts.extend(
        [
            "",
            "Return ONLY your review JSON per the skill's output schema. No prose before or after.",
        ]
    )
    return "\n".join(parts).replace("{round_num}", str(round_num))
