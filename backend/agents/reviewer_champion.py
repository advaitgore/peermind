"""Champion reviewer — constructive critique scoped to a target venue."""
from __future__ import annotations

import json
from typing import Any

from .agent_factory import AgentSpec
from .skills import load_skill, render_prompt


def build_champion_spec(journal: dict[str, Any]) -> AgentSpec:
    skill = load_skill("champion")
    ctx = {
        "journal_name": journal["full_name"],
        "journal_rubric": journal["reviewer_guidelines_summary"],
        "journal_champion_inject": journal["persona_champion_inject"],
        "journal_criteria": journal["criteria"],
        "journal_score_range": journal["score_range"],
        "round_num": "{round_num}",
    }
    system = render_prompt(skill.system_prompt_template, ctx)
    return AgentSpec(
        name=f"peermind-champion-{journal.get('id', 'unknown')}",
        model="claude-opus-4-7",
        system=system,
        tools=[{"type": "agent_toolset_20260401"}],
    )


def build_champion_user_message(
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
                "## Previous rounds (yours = 'b', skeptic = 'a')",
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
            "Return ONLY your review JSON per the skill's output schema.",
        ]
    )
    return "\n".join(parts).replace("{round_num}", str(round_num))
