"""Fix Agent — generates unified-diff patches and tiered author action items."""
from __future__ import annotations

import json
from typing import Any

from .agent_factory import AgentSpec
from .skills import load_skill


def build_fix_agent_spec() -> AgentSpec:
    skill = load_skill("fix_agent")
    return AgentSpec(
        # Opus 4.7 because generating unified diffs correctly — matching line
        # numbers, exact context, and judging auto-apply vs. author-required
        # severity — needs the stronger reasoning. Worth the spend.
        name="peermind-fix-agent",
        model="claude-opus-4-7",
        system=skill.system_prompt_template,
        tools=[{"type": "agent_toolset_20260401"}],
        max_tokens=8192,
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
