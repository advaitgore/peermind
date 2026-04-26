"""Fix Agent — generates unified-diff patches and tiered author action items."""
from __future__ import annotations

import json
from typing import Any

from .agent_factory import AgentSpec
from .skills import load_skill


def build_fix_agent_spec() -> AgentSpec:
    skill = load_skill("fix_agent")
    return AgentSpec(
        # Opus 4.7 on Fix Agent — diff correctness + citation reasoning
        # needs the stronger model. The updated skill prompt asks for 10+
        # unified diffs (each with 3 lines of context) plus a tiered
        # author_required list with fix_hint sub-diffs. 16k keeps
        # generation from truncating mid-JSON on a long review.
        name="peermind-fix-agent",
        model="claude-opus-4-7",
        system=skill.system_prompt_template,
        tools=[{"type": "agent_toolset_20260401"}],
        max_tokens=16384,
    )


def build_fix_user_message(
    paper_source: str,
    verdict_draft: dict[str, Any],
    all_reviews: list[dict[str, Any]],
    literature_findings: list[dict[str, Any]],
    code_results: list[dict[str, Any]],
    main_tex_name: str,
) -> str:
    return json.dumps(
        {
            "main_tex_name": main_tex_name,
            "paper_source": paper_source[:120_000],
            "verdict_draft": verdict_draft,
            "all_reviews": all_reviews,
            "literature_findings": literature_findings,
            "code_results": code_results,
        },
        indent=2,
    )[:200_000]
