"""Code Runner — runs code blocks from the paper in the container for reproducibility check."""
from __future__ import annotations

import json
from typing import Any

from .agent_factory import AgentSpec
from .skills import load_skill


def build_code_runner_spec() -> AgentSpec:
    skill = load_skill("code_runner")
    return AgentSpec(
        name="peermind-code-runner",
        model="claude-sonnet-4-5",
        system=skill.system_prompt_template,
        # bash/read/write/edit all available via the default Managed Agents
        # container toolset. The Code Runner is the one role that genuinely
        # needs a real sandbox — we dispatch it through Managed Agents so it
        # executes paper code in the cloud container instead of a local fake.
        tools=[{"type": "agent_toolset_20260401"}],
        requires_managed_agents=True,
    )


def build_code_runner_user_message(code_blocks: list[dict[str, Any]]) -> str:
    # Trim to most promising blocks: prefer ones that look like Python or have >20 chars.
    def _score(b: dict[str, Any]) -> int:
        lang = (b.get("language") or "").lower()
        code = b.get("code") or ""
        s = 0
        if lang in {"python", "py"}:
            s += 10
        if lang in {"bash", "sh"}:
            s += 5
        s += min(len(code) // 100, 5)
        return s

    ranked = sorted(code_blocks, key=_score, reverse=True)[:5]
    return json.dumps({"code_blocks": ranked}, indent=2)
